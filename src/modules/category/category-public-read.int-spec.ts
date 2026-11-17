import mongoose, { mongo } from 'mongoose'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import { CategoryPublicReadService } from './category-public-read.service'
const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
let service: CategoryPublicReadService
beforeAll(async () => {
	await connectTestDb('category-public-read')
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	service = new CategoryPublicReadService(mongoose.connection)
})
afterAll(async () => {
	await dropTestDb(mongoose)
})
async function control() {
	await mongoose.connection.db!.collection('catalog_control').insertOne({
		_id: 'catalog',
		phase: 'idle',
		revision: 7,
		epoch: 9
	} as never)
}
const node = (n: number, extra: Record<string, unknown> = {}) => ({
	_id: id(n),
	name: `Category ${n}`,
	slug: `category-${n}`,
	...extra
})
it('preserves legacy public fields and excludes arbitrary stored fields', async () => {
	const createdAt = new Date('2026-01-01')
	await mongoose.connection.collection('categories').insertOne(
		node(1, {
			createdAt,
			image: 'https://example.com/photo.jpg',
			internal_note: 'secret',
			google_product_category: { id: 123, path: 'Example', secret: true },
			presentation: { product_name_suffix: 'Suffix', secret: true },
			required_attributes: [
				{
					key: 'weight',
					label: 'Weight',
					filter_type: 'range',
					is_required: true,
					unit: 'kg',
					secret: true
				}
			]
		})
	)
	const result = await service.findBySlug('category-1')
	expect(result).toMatchObject({
		revision: 0,
		ancestors: [],
		createdAt,
		kind: 'product',
		required_attributes: [{ key: 'weight', unit: 'kg' }]
	})
	expect(JSON.stringify(result)).not.toContain('secret')
	// A suffix stored before it was retired (2026-11-05) is not public either.
	expect(JSON.stringify(result)).not.toContain('Suffix')
})
it('reads mixed v1/v2, groups and root-first ancestors without flattening typed definitions', async () => {
	await control()
	await mongoose.connection.collection('categories').insertMany([
		node(1, { kind: 'group' }),
		node(2, { kind: 'group', parent_id: id(1) }),
		node(3, {
			parent_id: id(2),
			attribute_contract_version: 2,
			attribute_definitions: [
				{
					key: 'amps',
					label: 'Струм',
					value_type: 'number',
					unit: 'A',
					is_required: true,
					filter_enabled: true,
					filter_type: 'range',
					visible_in_specs: true,
					order: 0,
					multiple: false,
					semantic: 'generic',
					options: []
				}
			]
		}),
		node(4)
	])
	const result = await service.findById(String(id(3)))
	expect(result.ancestors.map(row => row._id)).toEqual([String(id(1)), String(id(2))])
	expect(result).toMatchObject({
		revision: 7,
		required_attributes: [],
		attribute_definitions: [{ key: 'amps', value_type: 'number' }]
	})
	expect((await service.findBySlug('category-1')).kind).toBe('group')
	expect((await service.findAll()).map(row => row._id)).toEqual([String(id(3)), String(id(4))])
})
it.each(['draft', 'archived'])('hides a %s ancestor and its active descendant', async status => {
	await control()
	await mongoose.connection
		.collection('categories')
		.insertMany([
			node(1, { kind: 'group', status }),
			node(2, { parent_id: id(1), status: 'active' })
		])
	expect(await service.findAll()).toEqual([])
	await expect(service.findBySlug('category-2')).rejects.toMatchObject({ status: 404 })
	await expect(service.findById(String(id(1)))).rejects.toMatchObject({ status: 404 })
})
it('reads an id in upper case as the same id (audit 11.11)', async () => {
	await mongoose.connection.collection('categories').insertOne(node(0xabcdef))
	const result = await service.findById(String(id(0xabcdef)).toUpperCase())
	expect(result._id).toBe('000000000000000000abcdef')
})
it('returns 404 for invalid or absent IDs without a Mongo cast error', async () => {
	await expect(service.findById('invalid')).rejects.toMatchObject({ status: 404 })
})
it('requires control for v2, and refuses reads during maintenance', async () => {
	await mongoose.connection
		.collection('categories')
		.insertOne(node(1, { attribute_contract_version: 2, attribute_definitions: [] }))
	await expect(service.findAll()).rejects.toMatchObject({ status: 503 })
	await control()
	expect(await service.findAll()).toHaveLength(1)
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'writing' } })
	await expect(service.findAll()).rejects.toMatchObject({ status: 503 })
})
it.each([
	{ parent_id: id(99) },
	{ attribute_contract_version: 3 },
	{ attribute_contract_version: 2, attribute_definitions: [{ invalid: true }] }
])('fails closed for corrupt public data %j', async extra => {
	await control()
	await mongoose.connection.collection('categories').insertOne(node(1, extra))
	await expect(service.findAll()).rejects.toMatchObject({ status: 503 })
})
it('rejects ambiguous visible slugs', async () => {
	await mongoose.connection
		.collection('categories')
		.insertMany([node(1), node(2, { slug: 'category-1' })])
	await expect(service.findBySlug('category-1')).rejects.toMatchObject({ status: 503 })
})
