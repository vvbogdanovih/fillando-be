import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import {
	CatalogWriteGate,
	CatalogWriteToken
} from 'src/database/mongoose/repositories/catalog-write-gate'
import { CatalogMutationJournal } from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { TypedProductController, TypedProductService } from './typed-product.controller'
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication, gate: CatalogWriteGate
const body = () => ({
	expected_revision: 0,
	category_id: id(1),
	vendor_id: id(2),
	name: 'АВР',
	attributes_v2: [{ k: 'automatic', v: false }],
	variant_axis: { key: 'current' },
	variants: [
		{ variant_value: 0, price: 100.25, stock: 0 },
		{ variant_value: 32, price: 200, stock: 5 }
	]
})
function create(payload: unknown = body(), key: string = randomUUID(), role = 'ADMIN') {
	const req = request(app.getHttpServer() as Server)
		.post('/products/admin/typed-drafts')
		.set('Idempotency-Key', key)
	if (role) req.set('x-test-role', role)
	return req.send(payload as object)
}
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('typed-product-create-http')
	app = await createRbacApp({
		controllers: [TypedProductController],
		providers: [
			TypedProductService,
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			{
				provide: APP_PIPE,
				useValue: new ValidationPipe({ whitelist: true, transform: true })
			}
		]
	})
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	gate = new CatalogWriteGate(db())
	await gate.initialize()
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
	await db()
		.collection('categories')
		.insertOne({
			_id: oid(1),
			name: 'АВР',
			slug: 'avr',
			kind: 'product',
			parent_id: null,
			status: 'draft',
			order: 0,
			attribute_contract_version: 2,
			attribute_definitions: [
				{
					key: 'current',
					label: 'Струм',
					value_type: 'number',
					unit: 'А',
					is_required: true,
					filter_enabled: true,
					filter_type: 'range',
					visible_in_specs: true,
					order: 0,
					multiple: false,
					semantic: 'generic',
					options: []
				},
				{
					key: 'automatic',
					label: 'Автоматичний',
					value_type: 'boolean',
					unit: null,
					is_required: false,
					filter_enabled: false,
					filter_type: null,
					visible_in_specs: true,
					order: 1,
					multiple: false,
					semantic: 'generic',
					options: []
				}
			]
		})
	await db()
		.collection('vendors')
		.insertOne({ _id: oid(2), name: 'Supplier' })
	await db().collection('numbers').insertOne({ sku: 100, order: 25 })
	await db().collection('product_variants').createIndex({ sku: 1 }, { unique: true })
	await db().collection('product_variants').createIndex({ slug: 1 }, { unique: true })
})
afterAll(async () => {
	await app?.close()
	await dropTestDb(mongoose)
})
it('creates one product and typed draft SKU, replays without reserving again, and retains URLs on rename', async () => {
	const key = randomUUID(),
		res = await create(body(), key)
	expect(res.status).toBe(201)
	const receipt = res.body as { operation_id: string; revision: number; product_id: string }
	expect(receipt.revision).toBe(1)
	expect((await create(body(), key)).body).toEqual(receipt)
	expect(await db().collection('products').countDocuments()).toBe(1)
	expect(await db().collection('product_variants').countDocuments()).toBe(2)
	expect((await db().collection('numbers').findOne({}))!.sku).toBe(102)
	const rows = await db().collection('product_variants').find({}).sort({ sku: 1 }).toArray()
	expect(rows[0]).toMatchObject({
		sku: 'FL-000101',
		slug: 'avr-0-a',
		variant_value: 0,
		price: 100.25,
		stock: 0,
		status: 'draft',
		color_id: null
	})
	expect(rows[1]).toMatchObject({ slug: 'avr-32-a', status: 'draft' })
	expect(rows[0].slug).not.toContain('dopys')
	expect((await create({ ...body(), name: 'Інший' }, key)).status).toBe(409)
	const read = await request(app.getHttpServer() as Server)
		.get(`/products/${receipt.product_id}/admin/typed-draft`)
		.set('x-test-role', 'ADMIN')
	expect(read.status).toBe(200)
	expect(read.body).toMatchObject({ attributes_v2: [{ k: 'automatic', v: false }], revision: 1 })
	const edit = await request(app.getHttpServer() as Server)
		.patch(`/products/${receipt.product_id}/admin/typed-draft`)
		.set('x-test-role', 'ADMIN')
		.set('Idempotency-Key', randomUUID())
		.send({
			expected_revision: 1,
			name: 'Нова назва',
			attributes_v2: [],
			variant_axis: { key: 'current' },
			variants: rows.map(row => ({
				id: String(row._id),
				variant_value: row.variant_value as unknown
			}))
		})
	expect(edit.status).toBe(200)
	expect(
		(await db().collection('product_variants').find({}).sort({ sku: 1 }).toArray()).map(
			row => row.slug as string
		)
	).toEqual(rows.map(row => row.slug as string))
})
it('supports a no-axis draft, excludes title copy from slug and resolves reserved old routes', async () => {
	await db()
		.collection('catalog_routes')
		.insertOne({
			path: '/products/kovdra',
			kind: 'alias',
			entity_type: 'variant',
			entity_id: id(9)
		})
	const res = await create({
		...body(),
		name: 'Ковдра',
		variant_axis: null,
		attributes_v2: [],
		variants: [{ variant_value: null, price: 0, stock: 0 }]
	})
	expect(res.status).toBe(201)
	expect(await db().collection('product_variants').findOne({})).toMatchObject({
		name: 'Ковдра',
		slug: 'kovdra-fl-000101',
		variant_value: null,
		status: 'draft'
	})
})
/**
 * Photos are added in the creation form (owner, 2026-11-15): the form uploads them first and the
 * command carries each SKU's public URLs, under the rule a details save applies to `images`.
 */
describe('photos of a new product', () => {
	const photo = (name: string) => `https://cdn.example.com/products/${id(77)}/${name}.webp`
	const withImages = (...images: unknown[]) => ({
		...body(),
		variants: body().variants.map((row, index) => ({ ...row, images: images[index] }))
	})
	it('stores each SKU’s photos in the order sent, and none where none were sent', async () => {
		const res = await create({
			...body(),
			variants: [
				{ ...body().variants[0], images: [photo('front'), photo('back')] },
				body().variants[1]
			]
		})
		expect(res.status).toBe(201)
		const rows = await db().collection('product_variants').find({}).sort({ sku: 1 }).toArray()
		expect(rows.map(row => row.images as string[])).toEqual([
			[photo('front'), photo('back')],
			[]
		])
		// The editor reads them back as each SKU's photos, the first one the main. Matched by SKU:
		// the read lists SKUs by `_id`, which is derived from the operation key, not from the order.
		const read = await request(app.getHttpServer() as Server)
			.get(`/products/${(res.body as { product_id: string }).product_id}/admin/typed-draft`)
			.set('x-test-role', 'ADMIN')
		const draft = read.body as {
			variants: { id: string; sku: string }[]
			details: { variants: { id: string; images: string[] }[] }
		}
		expect(
			Object.fromEntries(
				draft.variants.map(row => [
					row.sku,
					draft.details.variants.find(detail => detail.id === row.id)?.images
				])
			)
		).toEqual({ 'FL-000101': [photo('front'), photo('back')], 'FL-000102': [] })
	})
	it('answers a repeat of the same operation with the same receipt and creates nothing more', async () => {
		const key = randomUUID(),
			payload = withImages([photo('front')], [photo('side')])
		const first = await create(payload, key)
		expect(first.status).toBe(201)
		const repeat = await create(payload, key)
		expect({ status: repeat.status, body: repeat.body as unknown }).toEqual({
			status: 201,
			body: first.body as unknown
		})
		expect(await db().collection('products').countDocuments()).toBe(1)
		expect(await db().collection('product_variants').countDocuments()).toBe(2)
		expect((await db().collection('numbers').findOne({}))!.sku).toBe(102)
		// The key is bound to the photos too: other photos under it are another request.
		expect((await create(withImages([photo('other')], []), key)).status).toBe(409)
	})
	it.each([
		['a malformed address', () => withImages(['not a url'], [])],
		['an address that is not http(s)', () => withImages(['ftp://cdn.example.com/a.webp'], [])],
		['a script address', () => withImages(['javascript:alert(1)'], [])],
		['a value that is not text', () => withImages([42], [])],
		['a list that is not a list', () => withImages(photo('front'), [])],
		[
			'more than 30 photos',
			() =>
				withImages(
					Array.from({ length: 31 }, (_, index) => photo(`n${index}`)),
					[]
				)
		]
	])('refuses %s before any write', async (_name, payload) => {
		expect((await create(payload())).status).toBe(400)
		expect((await db().collection('numbers').findOne({}))!.sku).toBe(100)
		expect(await db().collection('products').countDocuments()).toBe(0)
		expect((await gate.readStamp()).revision).toBe(0)
	})
	it('takes 30 photos, the most a SKU holds', async () => {
		const full = Array.from({ length: 30 }, (_, index) => photo(`n${index}`))
		expect((await create(withImages(full, []))).status).toBe(201)
		expect(
			(await db().collection('product_variants').findOne({ sku: 'FL-000101' }))!.images
		).toEqual(full)
	})
})
/**
 * «Усе одразу» (owner, 2026-11-15): the creation form carries what the edit screen has — the
 * description, the purchase notice, each SKU's parcel weight — and a new product is a draft
 * unless «Активний» is chosen, which the server accepts only for a complete product.
 */
describe('a whole product at creation, a draft unless complete', () => {
	const photo = `https://cdn.example.com/products/${id(77)}/front.webp`
	const complete = () => ({
		...body(),
		description: { html: '<p>Автомат <script>x()</script>резерву</p>', json: { ops: [] } },
		purchase_notice: { title: 'Увага', text: 'Монтує <b>електрик</b>.', badge: null },
		variants: body().variants.map((row, index) => ({
			...row,
			price: 100 + index,
			weight_g: 300 + index,
			images: [photo],
			status: 'active'
		}))
	})
	const publish = () =>
		db()
			.collection('categories')
			.updateOne({}, { $set: { status: 'active' } })
	const refusal = (res: { status: number; body: unknown }) => ({
		status: res.status,
		code: (res.body as { details: { code: string } }).details.code,
		issues: (
			(res.body as { details: { issues?: { code: string; field: string }[] } }).details
				.issues ?? []
		).map(issue => `${issue.code}:${issue.field}`)
	})
	const untouched = async () => {
		expect((await db().collection('numbers').findOne({}))!.sku).toBe(100)
		expect(await db().collection('products').countDocuments()).toBe(0)
		expect((await gate.readStamp()).revision).toBe(0)
	}

	it('stores the description sanitised, the notice as plain text and each SKU’s weight', async () => {
		const res = await create({
			...complete(),
			variants: complete().variants.map(row => ({ ...row, status: 'draft' }))
		})
		expect(res.status).toBe(201)
		expect(await db().collection('products').findOne({})).toMatchObject({
			description: { html: '<p>Автомат резерву</p>', json: { ops: [] } },
			purchase_notice: { title: 'Увага', text: 'Монтує електрик.', badge: null }
		})
		const rows = await db().collection('product_variants').find({}).sort({ sku: 1 }).toArray()
		expect(rows.map(row => [row.weight_g, row.status] as unknown[])).toEqual([
			[300, 'draft'],
			[301, 'draft']
		])
	})
	it('leaves out what was not sent: no description, no notice, unknown weight', async () => {
		expect((await create()).status).toBe(201)
		const product = await db().collection('products').findOne({})
		expect(product).not.toHaveProperty('description')
		expect(product).not.toHaveProperty('purchase_notice')
		expect((await db().collection('product_variants').findOne({}))!.weight_g).toBeNull()
	})
	it('creates a draft by default in a published category too, however incomplete', async () => {
		await publish()
		expect((await create()).status).toBe(201)
		expect(
			(await db().collection('product_variants').find({}).toArray()).map(
				row => row.status as string
			)
		).toEqual(['draft', 'draft'])
	})
	it('creates a complete product active at once', async () => {
		await publish()
		expect((await create(complete())).status).toBe(201)
		expect(
			(await db().collection('product_variants').find({}).toArray()).map(
				row => row.status as string
			)
		).toEqual(['active', 'active'])
	})
	it.each([
		[
			'no description',
			() => ({ ...complete(), description: null }),
			['DESCRIPTION_REQUIRED:description']
		],
		[
			'a description of markup only',
			() => ({ ...complete(), description: { html: '<p><br></p>', json: {} } }),
			['DESCRIPTION_REQUIRED:description']
		],
		[
			'a SKU without a photo',
			() => ({
				...complete(),
				variants: complete().variants.map((row, index) =>
					index ? { ...row, images: [] } : row
				)
			}),
			['IMAGE_REQUIRED:images']
		],
		[
			'a SKU priced 0',
			() => ({
				...complete(),
				variants: complete().variants.map((row, index) =>
					index ? row : { ...row, price: 0 }
				)
			}),
			['POSITIVE_PRICE_REQUIRED:price']
		],
		[
			'every gap at once',
			() => ({
				...body(),
				variants: body().variants.map(row => ({ ...row, status: 'active' }))
			}),
			[
				'DESCRIPTION_REQUIRED:description',
				'POSITIVE_PRICE_REQUIRED:price',
				'IMAGE_REQUIRED:images',
				'IMAGE_REQUIRED:images'
			]
		]
	])(
		'refuses an active product with %s, naming what is missing',
		async (_name, payload, issues) => {
			await publish()
			// The second SKU of the default body costs 200; only the first is priced above zero here.
			const res = await create(
				_name === 'every gap at once'
					? {
							...payload(),
							variants: payload().variants.map((row, index) =>
								index ? row : { ...row, price: 0 }
							)
						}
					: payload()
			)
			expect(refusal(res)).toEqual({ status: 409, code: 'PRODUCT_NOT_READY', issues })
			await untouched()
		}
	)
	it('names a required characteristic an active product lacks, in the same refusal', async () => {
		await publish()
		await db()
			.collection('categories')
			.updateOne({}, { $set: { 'attribute_definitions.1.is_required': true } })
		const res = await create({ ...complete(), attributes_v2: [] })
		expect(refusal(res)).toEqual({
			status: 409,
			code: 'PRODUCT_NOT_READY',
			issues: ['REQUIRED_ATTRIBUTE:automatic']
		})
		await untouched()
		// The same product as a draft is saved: a draft may be incomplete.
		const draft = await create({
			...complete(),
			attributes_v2: [],
			variants: complete().variants.map(row => ({ ...row, status: 'draft' }))
		})
		expect(draft.status).toBe(201)
	})
	it('does not judge an unknown weight: it is a warning, never a refusal', async () => {
		await publish()
		const res = await create({
			...complete(),
			variants: complete().variants.map(row => ({ ...row, weight_g: null }))
		})
		expect(res.status).toBe(201)
	})
	it.each([
		['a weight of 0', { weight_g: 0 }],
		['a fractional weight', { weight_g: 1.5 }],
		['a description that is not the editor’s shape', { description: '<p>текст</p>' }],
		[
			'a notice without its text',
			{ purchase_notice: { title: 'Увага', text: '', badge: null } }
		]
	])('refuses %s as an invalid field', async (_name, extra) => {
		const { weight_g, ...product } = extra as { weight_g?: number }
		const res = await create({
			...body(),
			...product,
			variants: body().variants.map(row =>
				weight_g === undefined ? row : { ...row, weight_g }
			)
		})
		expect(res.status).toBe(400)
		await untouched()
	})
})
it('keeps slug collisions distinct without changing existing identities', async () => {
	await db()
		.collection('product_variants')
		.insertOne({ _id: oid(9), sku: 'OLD', slug: 'avr-0-a' })
	expect((await create()).status).toBe(201)
	expect(await db().collection('product_variants').findOne({ sku: 'FL-000101' })).toMatchObject({
		slug: 'avr-0-a-fl-000101'
	})
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(9) })
	).toMatchObject({ slug: 'avr-0-a' })
})
it('requires auth, rollout flag and a current revision', async () => {
	expect((await create(undefined, undefined, '')).status).toBe(401)
	expect((await create(undefined, undefined, 'USER')).status).toBe(403)
	expect((await create(body(), 'invalid')).status).toBe(400)
	expect((await create({ ...body(), expected_revision: 2 })).status).toBe(409)
	await db()
		.collection('catalog_control')
		.updateOne({}, { $unset: { admin_draft_writes_enabled: '' } })
	expect((await create()).status).toBe(503)
	expect(await db().collection('products').countDocuments()).toBe(0)
})
it.each([
	[
		'string price',
		() => ({ ...body(), variants: [{ variant_value: 16, price: '100', stock: 0 }] })
	],
	[
		'negative stock',
		() => ({ ...body(), variants: [{ variant_value: 16, price: 100, stock: -1 }] })
	],
	[
		'duplicate values',
		() => ({
			...body(),
			variants: [
				{ variant_value: 16, price: 100, stock: 0 },
				{ variant_value: 16, price: 100, stock: 0 }
			]
		})
	],
	[
		'untyped axis',
		() => ({ ...body(), variants: [{ variant_value: '16', price: 100, stock: 0 }] })
	],
	['client identity', () => ({ ...body(), slug: 'chosen-by-client' })],
	['multiple SKU without axis', () => ({ ...body(), variant_axis: null })]
])('rejects %s before counter reservation or domain writes', async (_name, payload) => {
	expect((await create(payload())).status).toBe(400)
	expect((await db().collection('numbers').findOne({}))!.sku).toBe(100)
	expect(await db().collection('products').countDocuments()).toBe(0)
	expect((await gate.readStamp()).revision).toBe(0)
})
it('requires existing vendor, a draft or published product category, unique indexes and a valid singleton counter', async () => {
	expect((await create({ ...body(), vendor_id: id(99) })).status).toBe(404)
	await db()
		.collection('categories')
		.updateOne({}, { $set: { status: 'archived' } })
	expect((await create()).status).toBe(409)
	await db()
		.collection('categories')
		.updateOne({}, { $set: { status: 'draft' } })
	await db().collection('product_variants').dropIndex('slug_1')
	expect((await create()).status).toBe(409)
	await db().collection('product_variants').createIndex({ slug: 1 }, { unique: true })
	await db().collection('numbers').deleteMany({})
	expect((await create()).status).toBe(409)
	expect(await db().collection('products').countDocuments()).toBe(0)
})
async function interrupted() {
	const key = randomUUID()
	const publish = jest
		.spyOn(CatalogWriteGate.prototype, 'publishVerified')
		.mockRejectedValueOnce(Error('lost publication'))
	try {
		expect((await create(body(), key)).status).toBe(503)
	} finally {
		publish.mockRestore()
	}
	const plan = await db()
		.collection<{ _id: string; token: CatalogWriteToken }>('catalog_mutation_plans')
		.findOne({ _id: key })
	// The writer left it `recovery_required` (audit 31.10.2026); the operator takes it over as
	// `scripts/catalog-recover.cjs` does, and rolls back with the new token.
	expect(
		await db().collection<{ _id: string }>('catalog_control').findOne({ _id: 'catalog' })
	).toMatchObject({ phase: 'recovery_required' })
	const journal = new CatalogMutationJournal(db(), gate)
	const token = await gate.claimRecovery(plan!.token, 'operator', true)
	await journal.adoptRecovery(plan!.token, token)
	await gate.finishRecovery(plan!.token, token)
	return { key, token, journal }
}
it('rolls back a created product in reverse order while never reusing reserved SKU numbers', async () => {
	const { token, journal } = await interrupted()
	await journal.execute(token, 'rollback')
	await gate.finishRolledBack(token)
	expect(await db().collection('products').countDocuments()).toBe(0)
	expect(await db().collection('product_variants').countDocuments()).toBe(0)
	expect((await db().collection('numbers').findOne({}))!.sku).toBe(102)
	const stamp = await gate.readStamp()
	const retry = await create({ ...body(), expected_revision: stamp.revision })
	expect({ status: retry.status, body: retry.body as unknown }).toMatchObject({ status: 201 })
	expect(await db().collection('product_variants').findOne({ sku: 'FL-000103' })).not.toBeNull()
})
it('preserves a newly created SKU if commerce changed during an interrupted operation', async () => {
	const { token, journal } = await interrupted()
	await db()
		.collection('product_variants')
		.updateOne({ sku: 'FL-000101' }, { $set: { price: 999 } })
	await expect(journal.execute(token, 'rollback')).rejects.toThrow('RECOVERY_CONFLICT')
	expect(await db().collection('products').countDocuments()).toBe(1)
	expect(await db().collection('product_variants').countDocuments()).toBe(2)
})
it('does not delete a created SKU referenced by a cart even during recovery', async () => {
	const { token, journal } = await interrupted()
	const variant = await db().collection('product_variants').findOne({ sku: 'FL-000102' })
	await db()
		.collection('carts')
		.insertOne({ items: [{ variant_id: variant!._id, quantity: 1 }] })
	await expect(journal.execute(token, 'rollback')).rejects.toThrow('CREATED_PRODUCT_IN_USE')
	expect(await db().collection('product_variants').countDocuments()).toBe(2)
})
