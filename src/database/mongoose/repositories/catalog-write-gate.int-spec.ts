import mongoose from 'mongoose'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../../test/integration-db'
import { CatalogWriteGate } from './catalog-write-gate'

let gate: CatalogWriteGate
beforeAll(async () => {
	// This suite performs destructive fixture cleanup, so never accept another target.
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test') {
		throw new Error('Only the disposable localhost test DB is allowed')
	}
	await connectTestDb('catalog-gate')
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	gate = new CatalogWriteGate(mongoose.connection.db!)
	await gate.initialize()
})
afterAll(async () => {
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})

it('allows only one of concurrent writers to acquire the same revision', async () => {
	const results = await Promise.allSettled(
		Array.from({ length: 12 }, (_, i) => gate.acquire(`op-${i}`, `hash-${i}`, `owner-${i}`, 0))
	)
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
	expect(results.filter(result => result.status === 'rejected')).toHaveLength(11)
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it('does not execute a concurrent retry of the same operation', async () => {
	const results = await Promise.allSettled([
		gate.acquire('same', 'hash', 'a', 0),
		gate.acquire('same', 'hash', 'b', 0)
	])
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
	await expect(gate.acquire('same', 'different', 'c', 0)).rejects.toMatchObject({
		code: 'IDEMPOTENCY_KEY_REUSED'
	})
})
it('publishes revision, persists a receipt and rejects stale revision and replay', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await gate.beginDomainWrites(token)
	await gate.publishVerified(token)
	expect(await gate.readStamp()).toEqual({ revision: 1, epoch: 1 })
	expect(await gate.operation('one')).toMatchObject({ status: 'completed', revision: 1 })
	await expect(gate.acquire('two', 'hash', 'owner', 0)).rejects.toMatchObject({
		code: 'CATEGORY_REVISION_CONFLICT'
	})
	await expect(gate.acquire('one', 'hash', 'owner', 1)).rejects.toMatchObject({
		code: 'OPERATION_ALREADY_REGISTERED'
	})
	await expect(gate.acquire('three', 'hash', 'owner', 1)).resolves.toMatchObject({ revision: 1 })
})
it('detects a write and abort during a read even though revision did not change', async () => {
	const stamp = await gate.readStamp()
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await gate.abortBeforeWrites(token)
	expect(await gate.readStamp()).toEqual({ revision: 0, epoch: 1 })
	await expect(gate.assertReadUnchanged(stamp)).rejects.toMatchObject({
		code: 'CATALOG_READ_CHANGED'
	})
	expect(await gate.operation('one')).toMatchObject({ status: 'aborted' })
})
it('forbids abort after a possible domain write and stays locked after failure', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await gate.beginDomainWrites(token)
	await expect(gate.abortBeforeWrites(token)).rejects.toMatchObject({
		code: 'CATALOG_ABORT_UNSAFE'
	})
	await gate.requireRecovery(token)
	const restarted = new CatalogWriteGate(mongoose.connection.db!)
	await restarted.initialize()
	await expect(restarted.acquire('two', 'hash', 'new-owner', 0)).rejects.toMatchObject({
		code: 'CATALOG_WRITE_IN_PROGRESS'
	})
	await expect(restarted.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it('rejects a foreign or stale owner', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await expect(gate.beginDomainWrites({ ...token, ownerId: 'other' })).rejects.toMatchObject({
		code: 'CATALOG_OWNERSHIP_LOST'
	})
	await gate.abortBeforeWrites(token)
	await gate.acquire('two', 'hash', 'owner', 0)
	await expect(gate.beginDomainWrites(token)).rejects.toMatchObject({
		code: 'CATALOG_OWNERSHIP_LOST'
	})
})
it('fails closed when control is missing instead of initializing it on demand', async () => {
	await mongoose.connection.collection('catalog_control').deleteMany({})
	await expect(gate.acquire('one', 'hash', 'owner', 0)).rejects.toMatchObject({
		code: 'CATALOG_CONTROL_MISSING'
	})
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it('keeps publication closed when receipt storage fails', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await gate.beginDomainWrites(token)
	// Simulates missing/corrupt journal receipt after the publication CAS.
	await mongoose.connection
		.collection<{ _id: string }>('catalog_operations')
		.deleteOne({ _id: 'one' })
	await expect(gate.publishVerified(token)).rejects.toMatchObject({
		code: 'CATALOG_RECEIPT_CONFLICT'
	})
	const control = await mongoose.connection.collection('catalog_control').findOne({})
	expect(control).toMatchObject({ phase: 'published', revision: 1 })
	await expect(gate.acquire('two', 'hash', 'owner', 1)).rejects.toMatchObject({
		code: 'CATALOG_WRITE_IN_PROGRESS'
	})
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it('does not let an unchanged idle read fail', async () => {
	await expect(gate.assertReadUnchanged(await gate.readStamp())).resolves.toBeUndefined()
})

it.each(['completed', 'aborted', 'rolled_back'] as const)(
	'finishes interrupted %s publication without advancing revision twice',
	async outcome => {
		const token = await gate.acquire('one', 'hash', 'owner', 0)
		const revision = outcome === 'completed' ? 1 : 0
		// Failure boundary after publication CAS, before receipt update.
		await mongoose.connection
			.collection('catalog_control')
			.updateOne(
				{},
				{ $set: { phase: 'published', publication_outcome: outcome, revision, epoch: 1 } }
			)
		await gate.recoverPublication(token, true)
		expect(await gate.operation('one')).toMatchObject({
			status: outcome,
			revision,
			publication_token: token
		})
		expect(await gate.readStamp()).toEqual({ revision, epoch: 1 })
		await gate.recoverPublication(token, true)
		expect(await gate.readStamp()).toEqual({ revision, epoch: 1 })
	}
)

it('finishes after receipt persistence and never unlocks a subsequent writer on retry', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await mongoose.connection.collection('catalog_control').updateOne(
		{},
		{
			$set: {
				phase: 'published',
				publication_outcome: 'completed',
				revision: 1,
				epoch: 1
			}
		}
	)
	await mongoose.connection
		.collection('catalog_operations')
		.updateOne({}, { $set: { status: 'completed', revision: 1, publication_token: token } })
	await gate.recoverPublication(token, true)
	const next = await gate.acquire('two', 'hash', 'owner', 1)
	await gate.recoverPublication(token, true)
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
	await expect(gate.assertWriting(next)).resolves.toBeUndefined()
})

it('does not guess a missing outcome or overwrite a contradictory receipt', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'published', revision: 1, epoch: 1 } })
	await expect(gate.recoverPublication(token, true)).rejects.toMatchObject({
		code: 'CATALOG_PUBLICATION_AMBIGUOUS'
	})
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { publication_outcome: 'completed' } })
	await mongoose.connection
		.collection('catalog_operations')
		.updateOne({}, { $set: { status: 'aborted' } })
	await expect(gate.recoverPublication(token, true)).rejects.toMatchObject({
		code: 'CATALOG_RECEIPT_CONFLICT'
	})
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})

it('requires stopped writers and refuses publication recovery while writes are ongoing', async () => {
	const token = await gate.acquire('one', 'hash', 'owner', 0)
	await expect(gate.recoverPublication(token, false)).rejects.toMatchObject({
		code: 'RECOVERY_REQUIRES_STOPPED_WRITERS'
	})
	await expect(gate.recoverPublication(token, true)).rejects.toMatchObject({
		code: 'CATALOG_OWNERSHIP_LOST'
	})
	await expect(gate.assertWriting(token)).resolves.toBeUndefined()
})
