import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { PublicCatalogService } from '../product/public-catalog.service'
import { TypedLandingController, TypedLandingService } from './typed-landing.controller'

/**
 * Typed landings of a v2 product category (Plan-0010 F07): journal-backed create/update/delete,
 * pins checked against the definitions, duplicate/slug/empty-on-publish guards, the storefront
 * count, and the gate revision shared with the rest of the catalogue.
 */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const definition = (key: string, extra: object = {}) => ({
	key,
	label: key,
	value_type: 'string',
	unit: null,
	is_required: false,
	multiple: false,
	filter_enabled: true,
	filter_type: 'multi-select',
	visible_in_specs: true,
	order: 0,
	semantic: 'generic',
	options: [],
	...extra
})
const pins = (polymer: string[], extra: object = {}) => ({
	attributes: [{ key: 'polymer', values: polymer }],
	...extra
})
const body = (extra: object = {}) => ({
	slug: 'pla',
	h1: 'Філамент PLA',
	title: 'PLA філамент — купити',
	meta_description: 'PLA для 3D-друку',
	intro_html: '<p>Вступ</p><script>alert(1)</script>',
	faq: [{ q: 'Що це?', a: 'Пластик' }],
	filters_v2: pins(['PLA']),
	status: 'draft',
	...extra
})
async function create(extra: object = {}, key = randomUUID()) {
	return request(server())
		.post('/landings/admin/typed')
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), category_id: id(1), ...body(extra) })
}
async function update(landing: string, extra: object = {}) {
	return request(server())
		.patch(`/landings/${landing}/admin/typed`)
		.set('Idempotency-Key', randomUUID())
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), ...body(extra) })
}
const list = () =>
	request(server())
		.get('/landings/admin/typed')
		.query({ category_id: id(1) })
		.set('x-test-role', 'ADMIN')

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('typed-landing')
	app = await createRbacApp({
		controllers: [TypedLandingController],
		providers: [
			TypedLandingService,
			{
				provide: PublicCatalogService,
				useFactory: () =>
					new PublicCatalogService(
						mongoose.connection,
						new CategoryPublicReadService(mongoose.connection)
					)
			},
			{ provide: getConnectionToken(), useValue: mongoose.connection }
		]
	})
})
afterAll(async () => {
	await app?.close()
	await dropTestDb(mongoose)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	await new CatalogWriteGate(db()).initialize()
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
	await db()
		.collection('categories')
		.insertMany([
			{
				_id: oid(1),
				name: 'Філамент',
				slug: 'filament',
				kind: 'product',
				parent_id: null,
				status: 'active',
				order: 0,
				attribute_contract_version: 2,
				attribute_definitions: [
					definition('polymer'),
					definition('note', { filter_enabled: false, filter_type: null }),
					definition('color', {
						semantic: 'color',
						filter_enabled: false,
						filter_type: null
					})
				]
			},
			{
				_id: oid(2),
				name: 'Легасі',
				slug: 'legacy',
				order: 1,
				required_attributes: []
			}
		])
	await db()
		.collection('products')
		.insertMany([
			{
				_id: oid(10),
				name: 'PLA',
				category_id: oid(1),
				attributes_v2: [{ k: 'polymer', v: 'PLA' }],
				variant_axis: { key: 'color' }
			},
			{
				_id: oid(11),
				name: 'PETG',
				category_id: oid(1),
				attributes_v2: [{ k: 'polymer', v: 'PETG' }],
				variant_axis: null
			}
		])
	await db()
		.collection('product_variants')
		.insertMany([
			{
				_id: oid(20),
				product_id: oid(10),
				category_id: oid(1),
				status: 'active',
				price: 500,
				stock: 1,
				color_family: 'black',
				variant_value: id(70)
			},
			{
				_id: oid(21),
				product_id: oid(10),
				category_id: oid(1),
				status: 'active',
				price: 500,
				stock: 0,
				color_family: 'white',
				variant_value: id(71)
			},
			{
				_id: oid(22),
				product_id: oid(11),
				category_id: oid(1),
				status: 'draft',
				price: 600,
				stock: 1,
				variant_value: null
			}
		])
})

it('lists at most 500 landings of a category and says when there are more (P06)', async () => {
	await mongoose.connection.collection('landings').insertMany(
		Array.from({ length: 501 }, (_, n) => ({
			category_id: new mongo.ObjectId(id(1)),
			slug: `bulk-${n}`,
			h1: `Bulk ${n}`,
			status: 'draft',
			order: n
		}))
	)
	const listed = (await list()).body as { items: { slug: string }[]; truncated: boolean }
	expect(listed.truncated).toBe(true)
	expect(listed.items).toHaveLength(500)
	expect(listed.items.at(-1)?.slug).toBe('bulk-499')
	await mongoose.connection.collection('landings').deleteOne({ slug: 'bulk-500' })
	expect(((await list()).body as { truncated: boolean }).truncated).toBe(false)
})
it('creates a draft landing through the journal, sanitizing its copy', async () => {
	const start = await revision()
	const key = randomUUID()
	const response = await create({}, key)
	expect(response.status).toBe(201)
	const landingId = (response.body as { landing_id: string }).landing_id
	expect(response.body).toMatchObject({ revision: start + 1 })
	expect(
		await db()
			.collection('landings')
			.findOne({ _id: new mongo.ObjectId(landingId) })
	).toMatchObject({
		category_id: oid(1),
		slug: 'pla',
		intro_html: '<p>Вступ</p>',
		filters_v2: {
			attributes: [{ key: 'polymer', values: ['PLA'] }],
			category_ids: [],
			brand_ids: [],
			color_families: []
		},
		contract_version: 2,
		status: 'draft',
		filters: {}
	})
	// The same key and body replay the receipt.
	const replay = await request(server())
		.post('/landings/admin/typed')
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: start, category_id: id(1), ...body() })
	expect(replay.body).toEqual(response.body)
	const listed = (await list()).body as {
		revision: number
		items: { slug: string; product_count: number }[]
	}
	expect(listed).toMatchObject({
		revision: start + 1,
		items: [{ slug: 'pla', product_count: 2 }]
	})
})

it('checks pins against the category and refuses duplicates, a taken slug and an empty publish', async () => {
	for (const filters_v2 of [
		{},
		pins(['PLA'], { category_ids: [id(1)] }),
		pins(['PLA'], { on_sale: true }),
		{ attributes: [{ key: 'note', values: ['x'] }] },
		{ attributes: [{ key: 'unknown', values: ['x'] }] },
		{ color_families: ['plaid'] }
	]) {
		const refused = await create({ filters_v2 })
		expect(refused.status).toBe(400)
	}
	expect((await create({ filters_v2: { attributes: [] } })).body).toMatchObject({
		details: { code: 'LANDING_PINS_REQUIRED' }
	})
	expect((await create()).status).toBe(201)
	expect(
		(
			await create({
				slug: 'pla-2',
				filters_v2: {
					attributes: [{ key: 'polymer', values: ['PLA'] }],
					color_families: []
				}
			})
		).body
	).toMatchObject({
		details: { code: 'LANDING_FILTERS_DUPLICATE' }
	})
	expect((await create({ filters_v2: pins(['PETG']) })).body).toMatchObject({
		details: { code: 'LANDING_SLUG_TAKEN' }
	})
	// PETG has only a draft SKU: nothing a shopper would see, so it cannot be published.
	expect(
		(await create({ slug: 'petg', filters_v2: pins(['PETG']), status: 'active' })).body
	).toMatchObject({ details: { code: 'LANDING_HAS_NO_PRODUCTS' } })
	// A colour pin is fine under a colour axis and counted by the SKU family.
	const black = await create({
		slug: 'black',
		filters_v2: { color_families: ['black'] },
		status: 'active'
	})
	expect(black.status).toBe(201)
	const items = ((await list()).body as { items: { slug: string; product_count: number }[] })
		.items
	expect(items.map(row => [row.slug, row.product_count]).sort()).toEqual([
		['black', 1],
		['pla', 2]
	])
	expect(await db().collection('catalog_control').findOne({})).toMatchObject({ phase: 'idle' })
})

it('refuses the old address of another landing, keeping its 301 (B07)', async () => {
	// `/filament/pla-old` moved to another landing: a new landing there would end that redirect.
	await db()
		.collection('catalog_routes')
		.insertOne({
			path: '/filament/pla-old',
			kind: 'alias',
			entity_type: 'landing',
			entity_id: oid(77)
		})
	expect((await create({ slug: 'pla-old' })).body).toMatchObject({
		details: { code: 'LANDING_SLUG_TAKEN' }
	})
	const created = await create()
	expect(created.status).toBe(201)
	const landing = (created.body as { landing_id: string }).landing_id
	expect((await update(landing, { slug: 'pla-old' })).body).toMatchObject({
		details: { code: 'LANDING_SLUG_TAKEN' }
	})
	// Its own old address is not another entity's: a draft may take it back.
	await db()
		.collection('catalog_routes')
		.updateOne(
			{ path: '/filament/pla-old' },
			{ $set: { entity_id: new mongo.ObjectId(landing) } }
		)
	expect((await update(landing, { slug: 'pla-old' })).status).toBe(200)
	// An unchanged address is not re-judged: an ordinary save still works whatever lies there.
	await db()
		.collection('catalog_routes')
		.updateOne({ path: '/filament/pla-old' }, { $set: { entity_id: oid(78) } })
	expect((await update(landing, { slug: 'pla-old', h1: 'Інший заголовок' })).status).toBe(200)
})

it('updates only what changed, publishes, and deletes drafts only', async () => {
	const landingId = ((await create()).body as { landing_id: string }).landing_id
	const unchanged = await update(landingId)
	expect(unchanged.body).toMatchObject({ details: { code: 'LANDING_UNCHANGED' } })
	const published = await update(landingId, { status: 'active', h1: 'PLA пластик' })
	expect(published.body).toMatchObject({ landing_id: landingId })
	expect(
		(await update(landingId, { status: 'active', h1: 'PLA пластик', slug: 'pla-new' })).body
	).toMatchObject({ details: { code: 'LANDING_SLUG_LOCKED' } })
	const stored = await db()
		.collection('landings')
		.findOne({ _id: new mongo.ObjectId(landingId) })
	expect(stored).toMatchObject({ status: 'active', h1: 'PLA пластик', slug: 'pla' })
	const remove = async () =>
		request(server())
			.post(`/landings/${landingId}/admin/deletion`)
			.set('Idempotency-Key', randomUUID())
			.set('x-test-role', 'ADMIN')
			.send({ expected_revision: await revision() })
	expect((await remove()).body).toMatchObject({
		details: { code: 'LANDING_DELETE_REQUIRES_DRAFT' }
	})
	expect((await update(landingId, { status: 'draft', h1: 'PLA пластик' })).status).toBe(200)
	expect((await remove()).status).toBe(200)
	expect(await db().collection('landings').countDocuments()).toBe(0)
})

it('refuses a legacy category, is ADMIN-only, and is closed while admin writes are off', async () => {
	const legacy = await request(server())
		.get('/landings/admin/typed')
		.query({ category_id: id(2) })
		.set('x-test-role', 'ADMIN')
	expect(legacy.status).toBe(409)
	expect(
		(
			await request(server())
				.get('/landings/admin/typed')
				.query({ category_id: id(1) })
				.set('x-test-role', 'USER')
		).status
	).toBe(403)
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: false } })
	expect((await create()).status).toBe(503)
	expect(await db().collection('landings').countDocuments()).toBe(0)
})
