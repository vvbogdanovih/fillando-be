import mongoose, { mongo } from 'mongoose'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CategoryPublicReadService } from './category-public-read.service'
import { CategoryTreeReadService } from './category-tree-read.service'
const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
let service: CategoryTreeReadService
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('tree-read')
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	service = new CategoryTreeReadService(mongoose.connection)
})
afterAll(async () => {
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
it('paginates legacy nodes and detects edits even before revision-controlled writers', async () => {
	await mongoose.connection
		.collection('categories')
		.insertMany([1, 2, 3].map(n => ({ _id: id(n), name: `Category ${n}`, slug: `cat-${n}` })))
	const page = await service.read({ limit: 1 }, false)
	expect(page.items).toHaveLength(1)
	expect(page.items[0]).toMatchObject({ kind: 'product', parent_id: null, status: 'active' })
	const next = await service.read({ limit: 1, cursor: page.next_cursor! }, false)
	expect(next.items[0]._id).toBe(String(id(2)))
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: id(3) }, { $set: { name: 'Renamed' } })
	await expect(service.read({ cursor: next.next_cursor! }, false)).rejects.toMatchObject({
		status: 409
	})
})
it('hides inactive ancestor branches and never exposes unprojected fields', async () => {
	await mongoose.connection
		.db!.collection<{ _id: string }>('catalog_control')
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 3, epoch: 3 } as never)
	await mongoose.connection.collection('categories').insertMany([
		{ _id: id(1), name: 'Hidden', slug: 'hidden', kind: 'group', status: 'draft' },
		{
			_id: id(2),
			name: 'Child',
			slug: 'child',
			parent_id: id(1),
			kind: 'product',
			status: 'active'
		},
		{
			_id: id(3),
			name: 'Visible',
			slug: 'visible',
			private_field: 'not public',
			image: 'https://cdn.example.com/tile.png'
		}
	])
	expect((await service.read({}, false)).items.map(x => x._id)).toEqual([String(id(3))])
	const admin = (await service.read({}, true)).items
	expect(admin).toHaveLength(3)
	// The admin tree carries the tile image the new admin edits; the public one does not.
	expect(admin.find(x => x._id === String(id(3)))).toMatchObject({
		image: 'https://cdn.example.com/tile.png'
	})
	expect(admin.find(x => x._id === String(id(1)))).toMatchObject({ image: null })
	expect((await service.read({}, false)).items[0]).not.toHaveProperty('private_field')
	expect((await service.read({}, false)).items[0]).not.toHaveProperty('image')
})
it('rejects stale revisions, audience reuse and malformed cursor', async () => {
	await mongoose.connection
		.db!.collection('catalog_control')
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 1, epoch: 1 } as never)
	await mongoose.connection
		.collection('categories')
		.insertMany([1, 2].map(n => ({ _id: id(n), name: 'Cat', slug: `cat-${n}` })))
	const page = await service.read({ limit: 1 }, true)
	await expect(service.read({ cursor: page.next_cursor! }, false)).rejects.toMatchObject({
		status: 400
	})
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $inc: { revision: 1, epoch: 1 } })
	await expect(service.read({ cursor: page.next_cursor! }, true)).rejects.toMatchObject({
		status: 409
	})
	await expect(service.read({ cursor: 'bad' }, true)).rejects.toMatchObject({ status: 400 })
})
it('fails closed on active mutations, corrupt topology and v2 without control', async () => {
	await mongoose.connection
		.collection('categories')
		.insertOne({ _id: id(1), name: 'Cat', slug: 'cat', kind: 'group' })
	await expect(service.read({}, false)).rejects.toMatchObject({ status: 503 })
	await mongoose.connection
		.db!.collection('catalog_control')
		.insertOne({ _id: 'catalog', phase: 'writing', revision: 1, epoch: 1 } as never)
	await expect(service.read({}, true)).rejects.toMatchObject({ status: 503 })
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'idle' } })
	await mongoose.connection.collection('categories').updateOne({}, { $set: { parent_id: id(1) } })
	await expect(service.read({}, true)).rejects.toMatchObject({ status: 503 })
})

it('paginates direct children by order/ID, binds scope, and hides absent/hidden parents', async () => {
	await mongoose.connection.db!.collection('catalog_control').insertOne({
		_id: 'catalog',
		phase: 'idle',
		revision: 1,
		epoch: 1
	} as never)
	await mongoose.connection.collection('categories').insertMany([
		{ _id: id(1), name: 'Root', slug: 'root', kind: 'group' },
		{ _id: id(2), name: 'Later', slug: 'later', parent_id: id(1), order: 10 },
		{ _id: id(3), name: 'Earlier', slug: 'earlier', parent_id: id(1), order: 1 },
		{ _id: id(4), name: 'Hidden', slug: 'hidden', kind: 'group', status: 'draft' }
	])
	expect((await service.read({}, false, null)).items.map(x => x._id)).toEqual([String(id(1))])
	const first = await service.read({ limit: 1 }, false, String(id(1)))
	expect(first.items[0]._id).toBe(String(id(3)))
	const next = await service.read({ limit: 1, cursor: first.next_cursor! }, false, String(id(1)))
	expect(next.items[0]._id).toBe(String(id(2)))
	expect(next.next_cursor).toBeNull()
	await expect(service.read({ cursor: first.next_cursor! }, false)).rejects.toMatchObject({
		status: 400
	})
	await expect(service.read({ cursor: first.next_cursor! }, false, null)).rejects.toMatchObject({
		status: 400
	})
	for (const parent of [id(4), id(99)]) {
		await expect(service.read({}, false, String(parent))).rejects.toMatchObject({ status: 404 })
	}
})
describe('product category options (Plan-0010 D06)', () => {
	const definition = (key: string) => ({
		key,
		label: key,
		value_type: 'string',
		unit: null,
		is_required: false,
		filter_enabled: false,
		filter_type: null,
		visible_in_specs: true,
		order: 0,
		multiple: false,
		semantic: 'generic',
		options: []
	})
	const required = (key: string) => ({
		key,
		label: key,
		filter_type: 'multi-select',
		is_required: false,
		unit: null
	})
	beforeEach(async () => {
		await mongoose.connection
			.db!.collection<{ _id: string }>('catalog_control')
			.insertOne({ _id: 'catalog', phase: 'idle', revision: 5, epoch: 2 } as never)
		const v2 = { kind: 'product', status: 'active', attribute_contract_version: 2 }
		await mongoose.connection.collection('categories').insertMany([
			{
				_id: id(1),
				name: 'Філамент',
				slug: 'filament',
				order: 2,
				image: 'https://cdn.example.invalid/f.webp',
				required_attributes: [required('polymer'), required('finish')],
				seo: { title: 'not in options' }
			},
			{ _id: id(2), name: 'Group', slug: 'group', kind: 'group', order: 0 },
			{
				_id: id(3),
				name: 'АВР',
				slug: 'avr',
				parent_id: id(2),
				order: 1,
				...v2,
				attribute_definitions: [definition('a'), definition('b'), definition('c')]
			},
			// Same order as АВР: ID decides, as in the legacy list.
			{
				_id: id(4),
				name: 'Ковдри',
				slug: 'blankets',
				parent_id: id(2),
				order: 1,
				...v2,
				attribute_definitions: []
			},
			{ _id: id(5), name: 'Hidden', slug: 'hidden', kind: 'group', status: 'draft' },
			{
				_id: id(6),
				name: 'Under hidden',
				slug: 'under',
				parent_id: id(5),
				...v2,
				attribute_definitions: []
			},
			{ _id: id(7), name: 'Archived', slug: 'archived', status: 'archived' },
			// A corrupt count source never breaks the list: it counts as none.
			{ _id: id(8), name: 'Corrupt', slug: 'corrupt', order: 9, required_attributes: 'x' }
		])
	})
	it('pages the legacy list’s set and order without the content', async () => {
		const first = await service.readOptions({ limit: 2 })
		const second = await service.readOptions({ limit: 2, cursor: first.next_cursor! })
		expect(second.next_cursor).toBeNull()
		expect(first.revision).toBe(5)
		expect([...first.items, ...second.items]).toEqual([
			{
				_id: String(id(3)),
				name: 'АВР',
				slug: 'avr',
				kind: 'product',
				attribute_contract_version: 2,
				order: 1,
				image: null,
				attribute_count: 3
			},
			{
				_id: String(id(4)),
				name: 'Ковдри',
				slug: 'blankets',
				kind: 'product',
				attribute_contract_version: 2,
				order: 1,
				image: null,
				attribute_count: 0
			},
			{
				_id: String(id(1)),
				name: 'Філамент',
				slug: 'filament',
				kind: 'product',
				attribute_contract_version: 1,
				order: 2,
				image: 'https://cdn.example.invalid/f.webp',
				attribute_count: 2
			},
			{
				_id: String(id(8)),
				name: 'Corrupt',
				slug: 'corrupt',
				kind: 'product',
				attribute_contract_version: 1,
				order: 9,
				image: null,
				attribute_count: 0
			}
		])
	})
	it('matches the legacy list item for item where that list can be read', async () => {
		await mongoose.connection.collection('categories').deleteOne({ _id: id(8) })
		const legacy = await new CategoryPublicReadService(mongoose.connection).findAll()
		const options = (await service.readOptions({ limit: 1000 })).items
		expect(options.map(item => [item._id, item.name, item.slug, item.order])).toEqual(
			legacy.map(item => [item._id, item.name, item.slug, item.order])
		)
		expect(options.map(item => item.attribute_count)).toEqual(
			legacy.map(item =>
				item.attribute_contract_version === 2
					? item.attribute_definitions.length
					: item.required_attributes.length
			)
		)
		expect(options.map(item => item.image)).toEqual(legacy.map(item => item.image))
	})
	it('restarts on a changed catalogue, binds the cursor to its scope, keeps the tree as it was', async () => {
		const page = await service.readOptions({ limit: 1 })
		await expect(service.read({ cursor: page.next_cursor! }, false)).rejects.toMatchObject({
			status: 400
		})
		// A raw write that changes only an option's content (no revision bump) restarts paging.
		await mongoose.connection
			.collection('categories')
			.updateOne({ _id: id(4) }, { $set: { image: 'https://cdn.example.invalid/b.webp' } })
		await expect(
			service.readOptions({ limit: 1, cursor: page.next_cursor! })
		).rejects.toMatchObject({ status: 409 })
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({ _id: 'catalog' } as never, { $inc: { revision: 1 } })
		const fresh = await service.readOptions({ limit: 1 })
		await expect(
			service.readOptions({ limit: 1, cursor: page.next_cursor! })
		).rejects.toMatchObject({ status: 409 })
		expect(fresh.revision).toBe(6)
		// The tree itself still carries no image or count for the public audience.
		const tree = (await service.read({}, false)).items
		expect(tree.every(item => !('image' in item) && !('attribute_count' in item))).toBe(true)
	})
})
