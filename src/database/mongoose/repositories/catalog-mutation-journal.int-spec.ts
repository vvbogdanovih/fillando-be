import mongoose, { mongo } from 'mongoose'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../../test/integration-db'
import { CatalogWriteGate, CatalogWriteToken } from './catalog-write-gate'
import { CatalogMutationJournal, CatalogPatch } from './catalog-mutation-journal'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
let gate: CatalogWriteGate, journal: CatalogMutationJournal, token: CatalogWriteToken
const id1 = '000000000000000000000001',
	id2 = '000000000000000000000002'
const target = new mongo.ObjectId('000000000000000000000099')
const patches = (): CatalogPatch[] =>
	[id1, id2].map(id => ({
		collection: 'product_variants',
		id,
		fields: {
			category_id: { before: { exists: false }, after: { exists: true, value: target } }
		}
	}))
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('catalog-journal')
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	gate = new CatalogWriteGate(mongoose.connection.db!)
	journal = new CatalogMutationJournal(mongoose.connection.db!, gate)
	await gate.initialize()
	token = await gate.acquire('test-operation', 'test-hash', 'test-owner', 0)
	await mongoose.connection
		.collection('product_variants')
		.insertMany([id1, id2].map(id => ({ _id: new mongo.ObjectId(id), price: 100, stock: 2 })))
})
afterAll(async () => {
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
it('resumes after a write without a checkpoint and publishes only after verification', async () => {
	await journal.prepare(token, patches())
	await gate.beginDomainWrites(token)
	// Fault boundary: first domain write happened, checkpoint was not persisted.
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: new mongo.ObjectId(id1) }, { $set: { category_id: target } })
	const restarted = new CatalogMutationJournal(mongoose.connection.db!, gate)
	await restarted.execute(token, 'apply')
	await restarted.execute(token, 'apply')
	expect(
		await mongoose.connection
			.collection('product_variants')
			.countDocuments({ category_id: target })
	).toBe(2)
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
	await gate.publishVerified(token)
	expect(await gate.readStamp()).toEqual({ revision: 1, epoch: 1 })
})
it('rolls back only owned fields, preserving concurrent price and stock changes', async () => {
	await journal.prepare(token, patches())
	await journal.execute(token, 'apply')
	await mongoose.connection
		.collection('product_variants')
		.updateMany({}, { $set: { price: 130, stock: 7 } })
	await journal.execute(token, 'rollback')
	await journal.execute(token, 'rollback')
	const rows = await mongoose.connection.collection('product_variants').find({}).toArray()
	for (const row of rows) {
		expect(row).not.toHaveProperty('category_id')
		expect(row).toMatchObject({ price: 130, stock: 7 })
	}
	await gate.finishRolledBack(token)
	expect(await gate.operation(token.operationId)).toMatchObject({
		status: 'rolled_back',
		revision: 0
	})
	expect(await gate.readStamp()).toEqual({ revision: 0, epoch: 1 })
})
it('refuses divergent data before touching any other target', async () => {
	await journal.prepare(token, patches())
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: new mongo.ObjectId(id2) }, { $set: { category_id: 'unexpected' } })
	await expect(journal.execute(token, 'apply')).rejects.toMatchObject({
		code: 'RECOVERY_CONFLICT'
	})
	expect(
		await mongoose.connection
			.collection('product_variants')
			.findOne({ _id: new mongo.ObjectId(id1) })
	).not.toHaveProperty('category_id')
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it('distinguishes missing fields from explicit null and restores null exactly', async () => {
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: new mongo.ObjectId(id1) }, { $set: { category_id: null } })
	await expect(journal.prepare(token, patches())).rejects.toMatchObject({
		code: 'RECOVERY_CONFLICT'
	})
	const plan = patches()
	plan[0].fields.category_id.before = { exists: true, value: null }
	await journal.prepare(token, plan)
	await journal.execute(token, 'apply')
	await journal.execute(token, 'rollback')
	expect(
		await mongoose.connection
			.collection('product_variants')
			.findOne({ _id: new mongo.ObjectId(id1) })
	).toHaveProperty('category_id', null)
})
it('refuses plan replacement, unsafe fields and repeated targets', async () => {
	const bad = patches()
	bad[0].fields.price = bad[0].fields.category_id
	await expect(journal.prepare(token, bad)).rejects.toMatchObject({ code: 'FORBIDDEN_FIELD' })
	await expect(journal.prepare(token, [patches()[0], patches()[0]])).rejects.toMatchObject({
		code: 'DUPLICATE_TARGET'
	})
	await journal.prepare(token, patches())
	await journal.prepare(token, patches())
	const altered = patches()
	altered[0].fields.category_id.after = { exists: true, value: null }
	await expect(journal.prepare(token, altered)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' })
})
it('cannot apply once rollback has been selected or reuse a stale token', async () => {
	await journal.prepare(token, patches())
	await journal.execute(token, 'rollback')
	await expect(journal.execute(token, 'apply')).rejects.toMatchObject({
		code: 'ROLLBACK_ALREADY_SELECTED'
	})
	await gate.finishRolledBack(token)
	await expect(journal.execute(token, 'rollback')).rejects.toMatchObject({
		code: 'CATALOG_OWNERSHIP_LOST'
	})
})
it('rejects a missing target and refuses rollback over external changes', async () => {
	await journal.prepare(token, patches())
	await journal.execute(token, 'apply')
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: new mongo.ObjectId(id2) }, { $set: { category_id: 'unexpected' } })
	await expect(journal.execute(token, 'rollback')).rejects.toMatchObject({
		code: 'RECOVERY_CONFLICT'
	})
	await mongoose.connection
		.collection('product_variants')
		.deleteOne({ _id: new mongo.ObjectId(id2) })
	await expect(journal.execute(token, 'rollback')).rejects.toMatchObject({
		code: 'TARGET_MISSING'
	})
})

it('rejects lossy BSON images instead of silently changing the stored plan', async () => {
	const plan = patches()
	plan[0].fields.category_id.after = { exists: true, value: { nested: undefined } }
	await expect(journal.prepare(token, plan)).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
	expect(await mongoose.connection.collection('catalog_mutation_plans').countDocuments()).toBe(0)
})

it('inspects without changing data and resumes under a new owner after recovery', async () => {
	await journal.prepare(token, patches())
	await gate.beginDomainWrites(token)
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: new mongo.ObjectId(id1) }, { $set: { category_id: target } })
	await gate.requireRecovery(token)
	const before = await journal.inspect(token.operationId)
	expect(before.counts).toEqual({ before: 1, after: 1, both: 0, conflict: 0, missing: 0 })
	const next = await gate.claimRecovery(token, 'recovery-owner', true)
	await expect(gate.beginDomainWrites(token)).rejects.toMatchObject({
		code: 'CATALOG_OWNERSHIP_LOST'
	})
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
	await journal.adoptRecovery(token, next)
	await gate.finishRecovery(token, next)
	await journal.execute(next, 'apply')
	await gate.publishVerified(next)
	expect(await gate.readStamp()).toEqual({ revision: 1, epoch: 2 })
	expect(await gate.operation(token.operationId)).toMatchObject({
		owner_id: 'recovery-owner',
		status: 'completed'
	})
})

it('retries interrupted ownership adoption and rolls back without losing new stock', async () => {
	await journal.prepare(token, patches())
	await journal.execute(token, 'apply')
	const next = await gate.claimRecovery(token, 'recovery-owner', true)
	const restartedGate = new CatalogWriteGate(mongoose.connection.db!)
	const restartedJournal = new CatalogMutationJournal(mongoose.connection.db!, restartedGate)
	expect(await restartedGate.claimRecovery(token, 'recovery-owner', true)).toEqual(next)
	await restartedJournal.adoptRecovery(token, next)
	await restartedJournal.adoptRecovery(token, next)
	await mongoose.connection.collection('product_variants').updateMany({}, { $set: { stock: 55 } })
	await restartedGate.finishRecovery(token, next)
	await restartedJournal.execute(next, 'rollback')
	await restartedGate.finishRolledBack(next)
	expect(await restartedGate.readStamp()).toEqual({ revision: 0, epoch: 2 })
	expect(
		await mongoose.connection
			.collection('product_variants')
			.countDocuments({ stock: 55, category_id: { $exists: false } })
	).toBe(2)
})

it('requires stopped writers and prevents competing recovery owners', async () => {
	await journal.prepare(token, patches())
	await expect(gate.claimRecovery(token, 'new-owner', false)).rejects.toMatchObject({
		code: 'RECOVERY_REQUIRES_STOPPED_WRITERS'
	})
	await expect(gate.claimRecovery(token, token.ownerId, true)).rejects.toMatchObject({
		code: 'RECOVERY_REQUIRES_STOPPED_WRITERS'
	})
	const results = await Promise.allSettled([
		gate.claimRecovery(token, 'new-a', true),
		gate.claimRecovery(token, 'new-b', true)
	])
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
	expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
})

it('keeps recovery closed on divergence and reports missing targets', async () => {
	await journal.prepare(token, patches())
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: new mongo.ObjectId(id1) }, { $set: { category_id: 'unexpected' } })
	await mongoose.connection
		.collection('product_variants')
		.deleteOne({ _id: new mongo.ObjectId(id2) })
	expect((await journal.inspect(token.operationId)).counts).toMatchObject({
		conflict: 1,
		missing: 1
	})
	const next = await gate.claimRecovery(token, 'new-owner', true)
	await expect(journal.adoptRecovery(token, next)).rejects.toMatchObject({
		code: 'RECOVERY_CONFLICT'
	})
	await expect(journal.execute(next, 'apply')).rejects.toMatchObject({
		code: 'CATALOG_OWNERSHIP_LOST'
	})
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})

const creation = (): CatalogPatch => ({
	collection: 'categories',
	id: String(target),
	fields: {},
	creation: {
		_id: target,
		name: 'Electrical',
		slug: 'electrical',
		parent_id: null,
		kind: 'group'
	}
})
it('resumes category creation after insert without checkpoint, then rolls it back idempotently', async () => {
	const patch = creation()
	await journal.prepare(token, [patch])
	await gate.beginDomainWrites(token)
	await mongoose.connection.collection('categories').insertOne(patch.creation!)
	await journal.execute(token, 'apply')
	expect((await journal.inspect(token.operationId)).counts.after).toBe(1)
	await journal.execute(token, 'rollback')
	await journal.execute(token, 'rollback')
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(0)
	await gate.finishRolledBack(token)
	expect((await gate.readStamp()).revision).toBe(0)
})
it('transfers ownership of a pending creation and applies exactly once', async () => {
	await journal.prepare(token, [creation()])
	const next = await gate.claimRecovery(token, 'new-creator', true)
	await journal.adoptRecovery(token, next)
	await gate.finishRecovery(token, next)
	await journal.execute(next, 'apply')
	await journal.execute(next, 'apply')
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(1)
})
it.each([
	'categories',
	'products',
	'product_variants',
	'landings',
	'catalog_routes',
	'storefront_settings'
])('refuses creation rollback with a new reference in %s', async collection => {
	await journal.prepare(token, [creation()])
	await journal.execute(token, 'apply')
	const reference =
		collection === 'categories'
			? { parent_id: target }
			: collection === 'catalog_routes'
				? { entity_type: 'category', entity_id: String(target) }
				: collection === 'storefront_settings'
					? { collections: [{ category_id: target }] }
					: { category_id: target }
	await mongoose.connection.collection(collection).insertOne(reference)
	await expect(journal.execute(token, 'rollback')).rejects.toMatchObject({
		code: 'CREATED_CATEGORY_IN_USE'
	})
	expect(
		await mongoose.connection.collection('categories').findOne({ _id: target })
	).not.toBeNull()
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it('never deletes a created category that drifted and rejects arbitrary collection inserts', async () => {
	await expect(
		journal.prepare(token, [{ ...creation(), collection: 'products' }])
	).rejects.toMatchObject({ code: 'INVALID_CREATION' })
	await journal.prepare(token, [creation()])
	await journal.execute(token, 'apply')
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: target }, { $set: { name: 'Changed elsewhere' } })
	await expect(journal.execute(token, 'rollback')).rejects.toMatchObject({
		code: 'RECOVERY_CONFLICT'
	})
})

it('rolls back its own child before the created parent in a composite plan', async () => {
	const parent = creation()
	const child: CatalogPatch = {
		collection: 'categories',
		id: id1,
		fields: {},
		creation: {
			_id: new mongo.ObjectId(id1),
			name: 'Child',
			slug: 'child',
			parent_id: target,
			kind: 'product'
		}
	}
	await journal.prepare(token, [parent, child])
	await journal.execute(token, 'apply')
	await journal.execute(token, 'rollback')
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(0)
})

const deletion = (): CatalogPatch => ({
	collection: 'categories',
	id: String(target),
	fields: {},
	deletion: {
		...creation().creation!,
		status: 'draft',
		attribute_contract_version: 2,
		attribute_definitions: []
	}
})
it('recovers a deletion without checkpoint, resumes it and restores the exact BSON image on rollback', async () => {
	const patch = deletion()
	patch.deletion!.createdAt = new Date('2026-01-01T00:00:00Z')
	await mongoose.connection.collection('categories').insertOne(patch.deletion!)
	await journal.prepare(token, [patch])
	await gate.beginDomainWrites(token)
	await mongoose.connection.collection('categories').deleteOne({ _id: target })
	expect((await journal.inspect(token.operationId)).counts).toMatchObject({
		after: 1,
		missing: 0
	})
	const next = await gate.claimRecovery(token, 'delete-recovery', true)
	await journal.adoptRecovery(token, next)
	await gate.finishRecovery(token, next)
	await journal.execute(next, 'apply')
	await journal.execute(next, 'apply')
	await journal.execute(next, 'rollback')
	await journal.execute(next, 'rollback')
	expect(await mongoose.connection.collection('categories').findOne({ _id: target })).toEqual(
		patch.deletion
	)
	await gate.finishRolledBack(next)
	expect((await gate.readStamp()).revision).toBe(0)
})
it('rechecks dependencies immediately before deleting and never erases an externally changed image', async () => {
	const patch = deletion()
	await mongoose.connection.collection('categories').insertOne(patch.deletion!)
	await journal.prepare(token, [patch])
	await mongoose.connection.collection('landings').insertOne({ category_id: target })
	await expect(journal.execute(token, 'apply')).rejects.toMatchObject({ code: 'CATEGORY_IN_USE' })
	await mongoose.connection.collection('landings').deleteMany({})
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: target }, { $set: { name: 'External edit' } })
	await expect(journal.execute(token, 'apply')).rejects.toMatchObject({
		code: 'RECOVERY_CONFLICT'
	})
	expect(
		await mongoose.connection.collection('categories').findOne({ _id: target })
	).toMatchObject({ name: 'External edit' })
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})
it.each(['identity', 'parent', 'replacement'])(
	'keeps deletion rollback closed on %s conflict',
	async conflict => {
		const patch = deletion()
		if (conflict === 'parent') {
			patch.deletion!.parent_id = new mongo.ObjectId(id1)
			await mongoose.connection.collection('categories').insertOne({
				_id: new mongo.ObjectId(id1),
				kind: 'group',
				attribute_contract_version: 2
			})
		}
		await mongoose.connection.collection('categories').insertOne(patch.deletion!)
		await journal.prepare(token, [patch])
		await journal.execute(token, 'apply')
		if (conflict === 'parent') await mongoose.connection.collection('categories').deleteMany({})
		else
			await mongoose.connection.collection('categories').insertOne({
				_id: conflict === 'replacement' ? target : new mongo.ObjectId(),
				slug: patch.deletion!.slug,
				name: 'Other category'
			})
		await expect(journal.execute(token, 'rollback')).rejects.toMatchObject({
			code: 'RECOVERY_CONFLICT'
		})
		await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
	}
)
it('rejects unsupported lifecycle plans before storing a journal', async () => {
	const patch = deletion()
	for (const invalid of [
		{ ...patch, collection: 'products' as const },
		{ ...patch, creation: creation().creation },
		{ ...patch, deletion: { ...patch.deletion, status: 'active' } },
		{ ...patch, deletion: { ...patch.deletion, attribute_contract_version: 1 } }
	])
		await expect(journal.prepare(token, [invalid])).rejects.toMatchObject({
			code: 'INVALID_DELETION'
		})
	expect(await mongoose.connection.collection('catalog_mutation_plans').countDocuments()).toBe(0)
})

it('does not accept an already deleted target with a dangling reference on resume', async () => {
	const patch = deletion()
	await mongoose.connection.collection('categories').insertOne(patch.deletion!)
	await journal.prepare(token, [patch])
	await gate.beginDomainWrites(token)
	await mongoose.connection.collection('categories').deleteOne({ _id: target })
	await mongoose.connection.collection('products').insertOne({ category_id: target })
	await expect(journal.execute(token, 'apply')).rejects.toMatchObject({ code: 'CATEGORY_IN_USE' })
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})

describe('a writer that fails (afterFailedWrite)', () => {
	const control = () =>
		mongoose.connection
			.collection<{ _id: string }>('catalog_control')
			.findOne({ _id: 'catalog' })
	it('releases the gate when execute refuses before its first domain write', async () => {
		await journal.prepare(token, patches())
		// A writer outside the gate (Prom sync's check-then-write) changed a target after the plan.
		await mongoose.connection
			.collection('product_variants')
			.updateOne({ _id: new mongo.ObjectId(id2) }, { $set: { category_id: 'unexpected' } })
		await expect(journal.execute(token, 'apply')).rejects.toMatchObject({
			code: 'RECOVERY_CONFLICT'
		})
		await gate.afterFailedWrite(token, true)
		expect(await gate.readStamp()).toEqual({ revision: 0, epoch: 1 })
		expect(await gate.operation(token.operationId)).toMatchObject({ status: 'aborted' })
	})
	it('before execute releases exactly as abortBeforeWrites', async () => {
		await gate.afterFailedWrite(token, false)
		expect(await gate.readStamp()).toEqual({ revision: 0, epoch: 1 })
		await expect(gate.afterFailedWrite(token, false)).rejects.toMatchObject({
			code: 'CATALOG_ABORT_UNSAFE'
		})
	})
	it('marks recovery_required after a domain write, and the operator protocol takes it over', async () => {
		await journal.prepare(token, patches())
		await gate.beginDomainWrites(token)
		await mongoose.connection
			.collection('product_variants')
			.updateOne({ _id: new mongo.ObjectId(id1) }, { $set: { category_id: target } })
		await gate.afterFailedWrite(token, true)
		expect(await control()).toMatchObject({ phase: 'recovery_required', writes_started: true })
		await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
		// Repeating it (a retried failure path) changes nothing.
		await gate.afterFailedWrite(token, true)
		expect(await control()).toMatchObject({ phase: 'recovery_required' })
		const next = await gate.claimRecovery(token, 'operator', true)
		await journal.adoptRecovery(token, next)
		await gate.finishRecovery(token, next)
		await journal.execute(next, 'rollback')
		await gate.finishRolledBack(next)
		expect(await gate.readStamp()).toEqual({ revision: 0, epoch: 2 })
		expect(
			await mongoose.connection
				.collection('product_variants')
				.countDocuments({ category_id: { $exists: true } })
		).toBe(0)
	})
})

describe('the Merchant feed after a catalogue write', () => {
	// A completed operation moves the revision the feed is served under (503 CATALOG_FEED_STALE
	// until it is rebuilt); an aborted or rolled-back one discards a generation it overlapped —
	// so every outcome asks for the rebuild at once.
	let request: jest.SpyInstance
	beforeEach(() => {
		request = jest.spyOn(feedRefresh, 'request').mockImplementation(() => {})
	})
	afterEach(() => request.mockRestore())
	it('is asked for after a published, an aborted and a rolled-back operation', async () => {
		await journal.prepare(token, patches())
		await journal.execute(token, 'apply')
		expect(request).not.toHaveBeenCalled()
		await gate.publishVerified(token)
		expect(request).toHaveBeenCalledTimes(1)
		const refused = await gate.acquire('refused', 'hash', 'owner-2', 1)
		await gate.abortBeforeWrites(refused)
		expect(request).toHaveBeenCalledTimes(2)
		const undone = await gate.acquire('undone', 'hash', 'owner-3', 1)
		await journal.prepare(undone, [
			{
				collection: 'product_variants',
				id: id1,
				fields: {
					category_id: {
						before: { exists: true, value: target },
						after: { exists: false }
					}
				}
			}
		])
		await journal.execute(undone, 'apply')
		await journal.execute(undone, 'rollback')
		await gate.finishRolledBack(undone)
		expect(request).toHaveBeenCalledTimes(3)
	})
})
