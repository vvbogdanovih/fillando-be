import { CatalogMutationJournal } from 'src/database/mongoose/repositories/catalog-mutation-journal'
import mongoose, { mongo } from 'mongoose'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { CategoryTreeWriter } from './category-tree-writer'
const id = (n: number) => n.toString(16).padStart(24, '0')
let writer: CategoryTreeWriter, gate: CatalogWriteGate
const request = (operationId: string, expectedRevision: number) => ({
	operationId,
	expectedRevision,
	ownerId: `owner-${operationId}`
})
const create = (n: number, parent_id: string | null, kind: 'product' | 'group' = 'group') => ({
	id: id(n),
	parent_id,
	kind,
	order: 0,
	name: `Category ${n}`,
	slug: `category-${n}`,
	attribute_definitions: []
})
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('tree-writer')
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	gate = new CatalogWriteGate(mongoose.connection.db!)
	await gate.initialize()
	writer = new CategoryTreeWriter(mongoose.connection.db!)
})
afterAll(async () => {
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
it('creates a deep tree as drafts and moves a leaf without changing its name or URL', async () => {
	for (let n = 1; n <= 8; n++)
		await writer.create(
			request(`create-${n}`, n - 1),
			create(n, n === 1 ? null : id(n - 1), n === 8 ? 'product' : 'group')
		)
	const before = await mongoose.connection
		.collection('categories')
		.findOne({ _id: new mongo.ObjectId(id(8)) })
	expect(before).toMatchObject({ status: 'draft', attribute_contract_version: 2 })
	const result = await writer.move(request('move', 8), { id: id(8), parent_id: id(1), order: 7 })
	expect(result.revision).toBe(9)
	const after = await mongoose.connection
		.collection('categories')
		.findOne({ _id: new mongo.ObjectId(id(8)) })
	expect(after).toEqual({ ...before, parent_id: new mongo.ObjectId(id(1)), order: 7 })
})
it('rejects a cycle, product parent and identity collision before writes, reopening the gate', async () => {
	await writer.create(request('root', 0), create(1, null))
	await writer.create(request('child', 1), create(2, id(1)))
	await writer.create(request('leaf', 2), create(3, null, 'product'))
	await expect(
		writer.move(request('cycle', 3), { id: id(1), parent_id: id(2), order: 0 })
	).rejects.toThrow('CATEGORY_CYCLE')
	await expect(
		writer.move(request('leaf-parent', 3), { id: id(2), parent_id: id(3), order: 0 })
	).rejects.toThrow('PARENT_NOT_GROUP')
	await expect(
		writer.create(request('duplicate', 3), { ...create(4, null), slug: 'category-1' })
	).rejects.toThrow('CATEGORY_IDENTITY_CONFLICT')
	expect((await gate.readStamp()).revision).toBe(3)
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(3)
})
it('refuses an address the storefront owns or an old address of another entity (B07)', async () => {
	// A storefront route would shadow the category; a live page at an old address would
	// silently end that address's 301 to the entity that left it.
	for (const slug of ['checkout', 'catalog', 'products', 'faq', 'price-sheet'])
		await expect(
			writer.create(request(`reserved-${slug}`, 0), { ...create(1, null), slug })
		).rejects.toThrow('ROUTE_PATH_RESERVED')
	await mongoose.connection.collection('catalog_routes').insertOne({
		path: '/old-electrics',
		kind: 'alias',
		entity_type: 'category',
		entity_id: new mongo.ObjectId(id(50))
	})
	await expect(
		writer.create(request('alias', 0), { ...create(1, null), slug: 'old-electrics' })
	).rejects.toThrow('ROUTE_PATH_TAKEN')
	expect((await gate.readStamp()).revision).toBe(0)
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(0)
	await writer.create(request('free', 0), { ...create(1, null), slug: 'electrics' })
	expect((await gate.readStamp()).revision).toBe(1)
})
it('serializes competing moves so they cannot create a cycle', async () => {
	await writer.create(request('a', 0), create(1, null))
	await writer.create(request('b', 1), create(2, null))
	const results = await Promise.allSettled([
		writer.move(request('a-to-b', 2), { id: id(1), parent_id: id(2), order: 0 }),
		writer.move(request('b-to-a', 2), { id: id(2), parent_id: id(1), order: 0 })
	])
	expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1)
	expect(results.filter(x => x.status === 'rejected')).toHaveLength(1)
	expect((await gate.readStamp()).revision).toBe(3)
})
it('does not implicitly activate legacy categories or bootstrap a missing gate', async () => {
	await mongoose.connection
		.collection('categories')
		.insertOne({ _id: new mongo.ObjectId(id(1)), name: 'Legacy', slug: 'legacy' })
	await expect(
		writer.move(request('legacy-move', 0), { id: id(1), parent_id: null, order: 1 })
	).rejects.toThrow('CATALOG_CONTRACT_UPGRADE_REQUIRED')
	expect((await gate.readStamp()).revision).toBe(0)
	await mongoose.connection.collection('catalog_control').deleteMany({})
	await expect(writer.create(request('no-gate', 0), create(2, null))).rejects.toMatchObject({
		code: 'CATALOG_CONTROL_MISSING'
	})
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(1)
})

it('replays a completed request without touching a later operation and rejects changed payload', async () => {
	const first = await writer.create(request('create', 0), create(1, null))
	await writer.create(request('next', 1), create(2, null))
	expect(await writer.create(request('create', 0), create(1, null))).toEqual(first)
	expect((await gate.readStamp()).revision).toBe(2)
	await expect(
		writer.create(request('create', 0), { ...create(1, null), name: 'Different' })
	).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
})
it('keeps the gate closed after a persisted creation fails before publication, allowing journal recovery', async () => {
	// Captured before spying; the original receiver is explicitly restored with call below.
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const execute = CatalogMutationJournal.prototype.execute
	const fault = jest
		.spyOn(CatalogMutationJournal.prototype, 'execute')
		.mockImplementationOnce(async function (this: CatalogMutationJournal, token, direction) {
			await execute.call(this, token, direction)
			throw Error('simulated lost acknowledgement')
		})
	try {
		await expect(writer.create(request('interrupted', 0), create(1, null))).rejects.toThrow(
			'simulated lost acknowledgement'
		)
	} finally {
		fault.mockRestore()
	}
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(1)
	const journal = new CatalogMutationJournal(mongoose.connection.db!, gate)
	const previous = {
		operationId: 'interrupted',
		ownerId: 'owner-interrupted',
		revision: 0,
		epoch: 0
	}
	const next = await gate.claimRecovery(previous, 'recovery-owner', true)
	await journal.adoptRecovery(previous, next)
	await gate.finishRecovery(previous, next)
	await journal.execute(next, 'rollback')
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(0)
	await gate.finishRolledBack(next)
	expect((await gate.readStamp()).revision).toBe(0)
})

it('removes an unused draft, replays the receipt and never removes an active or legacy category', async () => {
	await writer.create(request('draft', 0), create(1, null))
	const removed = await writer.deleteDraft(request('remove', 1), id(1))
	expect(removed.revision).toBe(2)
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(0)
	expect(await writer.deleteDraft(request('remove', 1), id(1))).toEqual(removed)
	await writer.create(request('active', 2), create(2, null))
	await mongoose.connection.collection('categories').updateOne({}, { $set: { status: 'active' } })
	await expect(writer.deleteDraft(request('remove-active', 3), id(2))).rejects.toThrow(
		'CATEGORY_DELETE_REQUIRES_DRAFT'
	)
	await mongoose.connection
		.collection('categories')
		.insertOne({ _id: new mongo.ObjectId(id(3)), name: 'Legacy', slug: 'legacy' })
	await expect(writer.deleteDraft(request('remove-legacy', 3), id(3))).rejects.toThrow(
		'CATALOG_CONTRACT_UPGRADE_REQUIRED'
	)
	await expect(writer.deleteDraft(request('remove-missing', 3), id(99))).rejects.toThrow(
		'CATEGORY_NOT_FOUND'
	)
	expect((await gate.readStamp()).revision).toBe(3)
})

it.each([
	[
		'categories',
		{
			parent_id: new mongo.ObjectId(id(1)),
			name: 'Child',
			slug: 'child',
			attribute_contract_version: 2,
			attribute_definitions: []
		}
	],
	['products', { category_id: new mongo.ObjectId(id(1)) }],
	['product_variants', { category_id: id(1) }],
	['landings', { category_id: new mongo.ObjectId(id(1)), status: 'draft' }],
	['catalog_routes', { entity_type: 'category', entity_id: id(1), kind: 'alias' }],
	['storefront_settings', { collections: [{ category_id: new mongo.ObjectId(id(1)) }] }]
] as const)(
	'refuses deleting a category referenced by %s before writes',
	async (collection, reference) => {
		await writer.create(request('root', 0), create(1, null))
		await mongoose.connection.collection(collection).insertOne({ ...reference })
		await expect(writer.deleteDraft(request('remove-used', 1), id(1))).rejects.toThrow(
			'CATEGORY_IN_USE'
		)
		expect((await gate.readStamp()).revision).toBe(1)
		expect(await gate.operation('remove-used')).toMatchObject({ status: 'aborted' })
		expect(
			await mongoose.connection
				.collection('categories')
				.findOne({ _id: new mongo.ObjectId(id(1)) })
		).not.toBeNull()
		expect(
			await mongoose.connection
				.collection('catalog_mutation_plans')
				.findOne({ _id: 'remove-used' } as never)
		).toBeNull()
	}
)

it('serializes child creation against parent removal so no orphan can be committed', async () => {
	await writer.create(request('root', 0), create(1, null))
	const results = await Promise.allSettled([
		writer.deleteDraft(request('remove-root', 1), id(1)),
		writer.create(request('new-child', 1), create(2, id(1)))
	])
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
	const rows = await mongoose.connection.collection('categories').find().toArray()
	for (const row of rows)
		if (row.parent_id)
			expect(rows.some(parent => String(parent._id) === String(row.parent_id))).toBe(true)
	expect((await gate.readStamp()).revision).toBe(2)
})

it('explicitly converts an empty draft in both directions without changing identity or placement', async () => {
	await writer.create(request('root', 0), create(1, null))
	const before = await mongoose.connection
		.collection('categories')
		.findOne({ _id: new mongo.ObjectId(id(1)) })
	const input = { id: id(1), kind: 'product' as const, attribute_definitions: [] }
	const converted = await writer.convertDraft(request('to-product', 1), input)
	expect(
		await mongoose.connection
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id(1)) })
	).toEqual({ ...before, kind: 'product' })
	expect(await writer.convertDraft(request('to-product', 1), input)).toEqual(converted)
	await writer.convertDraft(request('to-group', 2), { ...input, kind: 'group' })
	expect(
		await mongoose.connection
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id(1)) })
	).toEqual(before)
	expect((await gate.readStamp()).revision).toBe(3)
})
it.each(['products', 'product_variants', 'landings'])(
	'refuses draft conversion when %s still reference it',
	async collection => {
		await writer.create(request('root', 0), create(1, null, 'product'))
		await mongoose.connection
			.collection(collection)
			.insertOne({ category_id: new mongo.ObjectId(id(1)) })
		await expect(
			writer.convertDraft(request('convert', 1), {
				id: id(1),
				kind: 'group',
				attribute_definitions: []
			})
		).rejects.toThrow('CATEGORY_IN_USE')
		expect((await gate.readStamp()).revision).toBe(1)
	}
)
it('refuses nonempty group conversion and active category conversion without trapping the gate', async () => {
	await writer.create(request('root', 0), create(1, null))
	await writer.create(request('child', 1), create(2, id(1)))
	await expect(
		writer.convertDraft(request('convert-parent', 2), {
			id: id(1),
			kind: 'product',
			attribute_definitions: []
		})
	).rejects.toThrow('CATEGORY_IN_USE')
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: new mongo.ObjectId(id(2)) }, { $set: { status: 'active' } })
	await expect(
		writer.convertDraft(request('convert-active', 2), {
			id: id(2),
			kind: 'product',
			attribute_definitions: []
		})
	).rejects.toThrow('CATEGORY_CONVERSION_REQUIRES_DRAFT')
	expect((await gate.readStamp()).revision).toBe(2)
})
