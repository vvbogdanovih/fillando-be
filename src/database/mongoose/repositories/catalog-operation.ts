import { createHash } from 'node:crypto'
import { mongo } from 'mongoose'
import { CatalogGateError, type CatalogWriteGate } from './catalog-write-gate'
import type { CatalogMutationJournal, CatalogPatch } from './catalog-mutation-journal'

export interface CatalogOperationRequest {
	operationId: string
	ownerId: string
	expectedRevision: number
}

/**
 * One admin catalogue operation under the gate and the journal, for the writers whose whole
 * write is a plan of patches: route changes, «Вітрина», typed landings, category SEO and export
 * (audit 11.11 — five copies of this protocol, where a divergence in one would reopen the gate
 * unsafely or leak a claimed operation). The order is the safety:
 *
 * 1. admin writes enabled, else `CATALOG_DRAFT_WRITES_DISABLED`;
 * 2. an operation already stored under this key: another request → `IDEMPOTENCY_KEY_REUSED`, a
 *    completed one → its receipt again, anything else → `OPERATION_ALREADY_REGISTERED`;
 * 3. `beforeAcquire`, then the gate (`expectedRevision`);
 * 4. inside it: the enabled check again, `build`, `prepare`, then `execute` — from here a failure
 *    keeps the gate for recovery (`afterFailedWrite` with `started`), before it the gate is released;
 * 5. with `verification`, every patch's after-image must be in place, else that error;
 * 6. `publishVerified` and the receipt of the new revision.
 *
 * Writers with steps of their own between these (the tree, publication, conversion) keep theirs.
 */
export async function runCatalogOperation<Extra extends object>(
	{
		db,
		gate,
		journal
	}: { db: mongo.Db; gate: CatalogWriteGate; journal: CatalogMutationJournal },
	operation: {
		request: CatalogOperationRequest
		/** Serialised as is into the request hash: keep the field order a stored operation has. */
		hashed: object
		/** Fields of the receipt after `operation_id` and `revision`. */
		receipt: Extra
		beforeAcquire?: () => Promise<unknown>
		/** Inside the gate: the patches, or a domain error (nothing written yet). */
		build: () => Promise<CatalogPatch[]>
		/** Thrown as `Error(verification)` when an applied target is missing its after-image. */
		verification?: string
	}
): Promise<{ operation_id: string; revision: number } & Extra> {
	const { request } = operation
	const hash = createHash('sha256').update(mongo.BSON.serialize(operation.hashed)).digest('hex')
	const enabled = () =>
		db
			.collection<{ _id: string }>('catalog_control')
			.findOne({ _id: 'catalog', admin_draft_writes_enabled: true })
	if (!(await enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
	const receipt = (revision: number) => ({
		operation_id: request.operationId,
		revision,
		...operation.receipt
	})
	const previous = await gate.operation(request.operationId)
	if (previous) {
		if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
		if (previous.status === 'completed' && previous.revision !== undefined)
			return receipt(previous.revision)
		throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
	}
	await operation.beforeAcquire?.()
	const token = await gate.acquire(
		request.operationId,
		hash,
		request.ownerId,
		request.expectedRevision
	)
	let started = false
	try {
		if (!(await enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
		const patches = await operation.build()
		await journal.prepare(token, patches)
		started = true
		await journal.execute(token, 'apply')
		if (operation.verification) {
			const inspection = await journal.inspect(request.operationId)
			if (inspection.counts.after + inspection.counts.both !== patches.length)
				throw Error(operation.verification)
		}
		await gate.publishVerified(token)
		return receipt(token.revision + 1)
	} catch (error) {
		await gate.afterFailedWrite(token, started)
		throw error
	}
}
