import { mongo } from 'mongoose'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'

interface Control {
	_id: string
	revision: number
	epoch: number
	phase: 'idle' | 'writing' | 'published' | 'recovery_required' | 'recovering'
	operation_id: string | null
	owner_id: string | null
	writes_started: boolean
	recovery_from?: CatalogWriteToken
	publication_outcome?: 'completed' | 'aborted' | 'rolled_back'
}
interface Operation {
	_id: string
	request_hash: string
	owner_id: string
	status: 'claimed' | 'rejected' | 'completed' | 'aborted' | 'rolled_back'
	revision?: number
	error?: string
	publication_token?: CatalogWriteToken
}
export interface CatalogWriteToken {
	operationId: string
	ownerId: string
	revision: number
	epoch: number
}
export class CatalogGateError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'CatalogGateError'
	}
}

/**
 * Persistence primitive only: no domain writes, TTL takeover or automatic bootstrap.
 * Not registered in the running app until all dependent readers/writers are integrated.
 */
export class CatalogWriteGate {
	private readonly control: mongo.Collection<Control>
	private readonly operations: mongo.Collection<Operation>

	constructor(db: mongo.Db) {
		this.control = db.collection<Control>('catalog_control', {
			writeConcern: { w: 1, j: true }
		})
		this.operations = db.collection<Operation>('catalog_operations', {
			writeConcern: { w: 1, j: true }
		})
	}

	/** Explicit migration/bootstrap step; never called as a fallback from acquire/read. */
	async initialize(): Promise<void> {
		await this.control.updateOne(
			{ _id: 'catalog' },
			{
				$setOnInsert: {
					_id: 'catalog',
					revision: 0,
					epoch: 0,
					phase: 'idle',
					operation_id: null,
					owner_id: null,
					writes_started: false
				}
			},
			{ upsert: true }
		)
	}

	async acquire(
		operationId: string,
		requestHash: string,
		ownerId: string,
		expectedRevision: number
	): Promise<CatalogWriteToken> {
		if (
			!operationId ||
			!requestHash ||
			!ownerId ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0
		) {
			throw new CatalogGateError('INVALID_GATE_REQUEST')
		}
		// Reserving the key first prevents two retries of the SAME operation from owning it.
		try {
			await this.operations.insertOne({
				_id: operationId,
				request_hash: requestHash,
				owner_id: ownerId,
				status: 'claimed'
			})
		} catch (error) {
			if ((error as { code?: number }).code !== 11000) throw error
			const operation = await this.operations.findOne(
				{ _id: operationId },
				{ readPreference: 'primary' }
			)
			if (!operation || operation.request_hash !== requestHash)
				throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}
		// An ambiguous network failure is intentionally not caught/unlocked.
		const state = await this.control.findOneAndUpdate(
			{ _id: 'catalog', phase: 'idle', revision: expectedRevision },
			{
				$set: {
					phase: 'writing',
					operation_id: operationId,
					owner_id: ownerId,
					writes_started: false
				}
			},
			{ returnDocument: 'after' }
		)
		if (!state) {
			const current = await this.control.findOne(
				{ _id: 'catalog' },
				{ readPreference: 'primary' }
			)
			const code = !current
				? 'CATALOG_CONTROL_MISSING'
				: current.phase !== 'idle'
					? 'CATALOG_WRITE_IN_PROGRESS'
					: 'CATEGORY_REVISION_CONFLICT'
			await this.operations.updateOne(
				{ _id: operationId, status: 'claimed' },
				{ $set: { status: 'rejected', error: code } }
			)
			throw new CatalogGateError(code)
		}
		return { operationId, ownerId, revision: state.revision, epoch: state.epoch }
	}

	/** Internal result lookup; HTTP adapters must enforce ADMIN and hide ownership/hash. */
	operation(id: string) {
		return this.operations.findOne({ _id: id }, { readPreference: 'primary' })
	}

	private filter(token: CatalogWriteToken) {
		return {
			_id: 'catalog',
			operation_id: token.operationId,
			owner_id: token.ownerId,
			revision: token.revision,
			epoch: token.epoch
		}
	}

	/** Does not fence an uncooperative writer; recovery must first isolate old processes. */
	async assertWriting(token: CatalogWriteToken): Promise<void> {
		const state = await this.control.findOne(
			{ ...this.filter(token), phase: 'writing' },
			{ readPreference: 'primary' }
		)
		if (!state) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
	}

	/** Only call after the domain journal has verified every restored before-image. */
	async finishRolledBack(token: CatalogWriteToken): Promise<void> {
		const result = await this.control.updateOne(
			{ ...this.filter(token), phase: 'writing', writes_started: true },
			{ $set: { phase: 'published', publication_outcome: 'rolled_back' }, $inc: { epoch: 1 } }
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
		await this.finishPublication(token, 'rolled_back', token.revision)
	}

	/** Operator-only protocol: confirmation is not fencing; stop/isolate old writers first. */
	async claimRecovery(
		previous: CatalogWriteToken,
		newOwner: string,
		writersStopped: boolean
	): Promise<CatalogWriteToken> {
		if (!writersStopped || !newOwner || newOwner === previous.ownerId) {
			throw new CatalogGateError('RECOVERY_REQUIRES_STOPPED_WRITERS')
		}
		const next = { ...previous, ownerId: newOwner, epoch: previous.epoch + 1 }
		const claimed = await this.control.findOneAndUpdate(
			{ ...this.filter(previous), phase: { $in: ['writing', 'recovery_required'] } },
			{
				$set: { phase: 'recovering', owner_id: newOwner, recovery_from: previous },
				$inc: { epoch: 1 }
			},
			{ returnDocument: 'after' }
		)
		if (!claimed) {
			const retry = await this.control.findOne(
				{ ...this.filter(next), phase: 'recovering', recovery_from: previous },
				{ readPreference: 'primary' }
			)
			if (!retry) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
		}
		return next
	}

	async assertRecovering(previous: CatalogWriteToken, next: CatalogWriteToken): Promise<void> {
		const state = await this.control.findOne(
			{ ...this.filter(next), phase: 'recovering', recovery_from: previous },
			{ readPreference: 'primary' }
		)
		if (!state) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
	}

	/** Call only after the journal has adopted the new token. Does not open public reads. */
	async finishRecovery(previous: CatalogWriteToken, next: CatalogWriteToken): Promise<void> {
		await this.assertRecovering(previous, next)
		const receipt = await this.operations.updateOne(
			{
				_id: next.operationId,
				owner_id: { $in: [previous.ownerId, next.ownerId] },
				status: 'claimed'
			},
			{ $set: { owner_id: next.ownerId } }
		)
		if (!receipt.matchedCount) throw new CatalogGateError('CATALOG_RECEIPT_CONFLICT')
		const result = await this.control.updateOne(
			{ ...this.filter(next), phase: 'recovering', recovery_from: previous },
			{ $set: { phase: 'writing' }, $unset: { recovery_from: '' } }
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
	}

	async beginDomainWrites(token: CatalogWriteToken): Promise<void> {
		const result = await this.control.updateOne(
			{ ...this.filter(token), phase: 'writing' },
			{ $set: { writes_started: true } }
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
	}

	/** Only validation failures BEFORE any domain write can safely release the gate. */
	async abortBeforeWrites(token: CatalogWriteToken): Promise<void> {
		const result = await this.control.updateOne(
			{ ...this.filter(token), phase: 'writing', writes_started: false },
			{ $set: { phase: 'published', publication_outcome: 'aborted' }, $inc: { epoch: 1 } }
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_ABORT_UNSAFE')
		await this.finishPublication(token, 'aborted', token.revision)
	}

	/**
	 * The failure path of every catalogue writer. Before `execute` started it releases the gate
	 * exactly as {@link abortBeforeWrites}. Once `execute` started, the gate is still released if
	 * no domain write happened (`writes_started` false: `execute` refused on its pre-check, e.g. a
	 * target changed after the plan was stored — Prom sync's check-then-write); otherwise the
	 * operation is marked `recovery_required` and stays closed for the operator recovery CLI
	 * (`scripts/catalog-recover.cjs`). After `execute` started it never throws, so the caller
	 * rethrows the original error.
	 */
	async afterFailedWrite(token: CatalogWriteToken, executionStarted: boolean): Promise<void> {
		if (!executionStarted) return this.abortBeforeWrites(token)
		try {
			await this.abortBeforeWrites(token)
			return
		} catch {
			// Domain writes started (or ownership is gone): keep the gate for recovery.
		}
		try {
			await this.requireRecovery(token)
		} catch {
			// Already recovery_required, published or taken over by a recovery owner.
		}
	}

	/** Caller must first persist and verify domain journal/after-images. Not a transaction. */
	async publishVerified(token: CatalogWriteToken): Promise<void> {
		const result = await this.control.updateOne(
			{ ...this.filter(token), phase: 'writing', writes_started: true },
			{
				$set: { phase: 'published', publication_outcome: 'completed' },
				$inc: { revision: 1, epoch: 1 }
			}
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
		await this.finishPublication(token, 'completed', token.revision + 1)
	}

	private async finishPublication(
		token: CatalogWriteToken,
		status: 'completed' | 'aborted' | 'rolled_back',
		revision: number
	) {
		const receipt = await this.operations.updateOne(
			{
				_id: token.operationId,
				owner_id: token.ownerId,
				$or: [{ status: 'claimed' }, { status, revision, publication_token: token }]
			},
			{ $set: { status, revision, publication_token: token } }
		)
		if (!receipt.matchedCount) throw new CatalogGateError('CATALOG_RECEIPT_CONFLICT')
		// Do not open the gate until the durable receipt exists. Crashes remain fail closed.
		const result = await this.control.updateOne(
			{
				_id: 'catalog',
				phase: 'published',
				operation_id: token.operationId,
				owner_id: token.ownerId,
				revision,
				epoch: token.epoch + 1,
				publication_outcome: status
			},
			{
				$set: { phase: 'idle', operation_id: null, owner_id: null, writes_started: false },
				$unset: { publication_outcome: '' }
			}
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
		// A completed operation moved the revision the Merchant feed is served under (`FeedService`
		// answers 503 CATALOG_FEED_STALE until a rebuild): ask for it now rather than on the next
		// GET. An aborted or rolled-back one leaves the served feed true, but a generation it
		// overlapped was discarded by its read barrier — so every outcome asks. A no-op without a
		// listener (another process, the CLIs, unit tests).
		feedRefresh.request(`catalogue operation ${status}`)
	}

	/** Reconcile publication bookkeeping only; never reapply domain data or advance revision. */
	async recoverPublication(token: CatalogWriteToken, writersStopped: boolean): Promise<void> {
		if (!writersStopped) throw new CatalogGateError('RECOVERY_REQUIRES_STOPPED_WRITERS')
		const state = await this.control.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		if (!state) throw new CatalogGateError('CATALOG_CONTROL_MISSING')
		if (
			state.phase === 'published' &&
			state.operation_id === token.operationId &&
			state.owner_id === token.ownerId &&
			state.epoch === token.epoch + 1
		) {
			const status = state.publication_outcome
			if (!status || !['completed', 'aborted', 'rolled_back'].includes(status))
				throw new CatalogGateError('CATALOG_PUBLICATION_AMBIGUOUS')
			const revision = token.revision + (status === 'completed' ? 1 : 0)
			if (state.revision !== revision)
				throw new CatalogGateError('CATALOG_PUBLICATION_AMBIGUOUS')
			await this.finishPublication(token, status, revision)
			return
		}
		// A completed retry can arrive after another writer acquired the gate. Do not touch it.
		const receipt = await this.operations.findOne(
			{
				_id: token.operationId,
				owner_id: token.ownerId,
				publication_token: token,
				status: { $in: ['completed', 'aborted', 'rolled_back'] }
			},
			{ readPreference: 'primary' }
		)
		if (!receipt) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
		if (state.operation_id === token.operationId)
			throw new CatalogGateError('CATALOG_PUBLICATION_AMBIGUOUS')
	}

	async requireRecovery(token: CatalogWriteToken): Promise<void> {
		const result = await this.control.updateOne(
			{ ...this.filter(token), phase: 'writing' },
			{ $set: { phase: 'recovery_required' } }
		)
		if (!result.matchedCount) throw new CatalogGateError('CATALOG_OWNERSHIP_LOST')
	}

	async readStamp(): Promise<{ revision: number; epoch: number }> {
		const state = await this.control.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		if (!state || state.phase !== 'idle') throw new CatalogGateError('CATALOG_MAINTENANCE')
		return { revision: state.revision, epoch: state.epoch }
	}

	async assertReadUnchanged(stamp: { revision: number; epoch: number }): Promise<void> {
		const current = await this.readStamp()
		if (current.revision !== stamp.revision || current.epoch !== stamp.epoch) {
			throw new CatalogGateError('CATALOG_READ_CHANGED')
		}
	}
}
