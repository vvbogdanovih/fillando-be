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
import { TypedProductWriter } from './typed-product-writer'
import { AttributeDefinition } from '../category/attribute-definitions'
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const definition = (key: string, type: AttributeDefinition['value_type']): AttributeDefinition => ({
	key,
	label: key,
	value_type: type,
	unit: null,
	is_required: true,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: []
})
let app: INestApplication, gate: CatalogWriteGate
const db = () => mongoose.connection.db!
const body = () => ({
	expected_revision: 0,
	name: 'АВР новий',
	attributes_v2: [{ k: 'automatic', v: false }],
	variant_axis: { key: 'current' },
	variants: [
		{ id: id(3), variant_value: 0 },
		{ id: id(4), variant_value: 32 }
	]
})
const path = `/products/${id(2)}/admin/typed-draft`
function edit(payload: object = body(), key: string = randomUUID(), role = 'ADMIN') {
	const req = request(app.getHttpServer() as Server)
		.patch(path)
		.set('Idempotency-Key', key)
	if (role) req.set('x-test-role', role)
	return req.send(payload)
}
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('typed-product-http')
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
				{ ...definition('current', 'number'), unit: 'А' },
				definition('automatic', 'boolean')
			]
		})
	await db()
		.collection('products')
		.insertOne({
			_id: oid(2),
			name: 'АВР',
			category_id: oid(1),
			attributes_v2: [],
			variant_axis: { key: 'current' },
			description: { html: 'keep' }
		})
	await db()
		.collection('product_variants')
		.insertMany(
			[3, 4].map((n, i) => ({
				_id: oid(n),
				category_id: oid(1),
				product_id: oid(2),
				name: `АВР — ${i ? 63 : 16} А`,
				variant_value: i ? 63 : 16,
				slug: `avr-${n}`,
				sku: `FL-00000${n}`,
				status: 'draft',
				price: 100,
				stock: 20,
				images: ['image'],
				promo_percent: 10
			}))
		)
})
afterAll(async () => {
	await app?.close()
	await dropTestDb(mongoose)
})
it('authenticates both routes and rejects writes when the opt-in flag is off', async () => {
	expect((await edit(undefined, undefined, '')).status).toBe(401)
	expect((await edit(undefined, undefined, 'USER')).status).toBe(403)
	expect(
		(
			await request(app.getHttpServer() as Server)
				.get(path)
				.set('x-test-role', 'USER')
		).status
	).toBe(403)
	await db()
		.collection('catalog_control')
		.updateOne({}, { $unset: { admin_draft_writes_enabled: '' } })
	expect((await edit()).status).toBe(503)
	expect((await gate.readStamp()).revision).toBe(0)
})
it('reads typed definitions and drafts without cache or implicit legacy conversion', async () => {
	const res = await request(app.getHttpServer() as Server)
		.get(path)
		.set('x-test-role', 'ADMIN')
	expect(res.status).toBe(200)
	expect(res.headers['cache-control']).toBe('no-store')
	expect(res.body).toMatchObject({
		product_id: id(2),
		revision: 0,
		variant_axis: { key: 'current' },
		variants: [{ name: 'АВР — 16 А', slug: 'avr-3' }, { name: 'АВР — 63 А' }]
	})
	await db()
		.collection('products')
		.updateOne({}, { $unset: { attributes_v2: '' } })
	expect(
		(
			await request(app.getHttpServer() as Server)
				.get(path)
				.set('x-test-role', 'ADMIN')
		).status
	).toBe(503)
})
it('writes false and zero, updates suffixes, preserves URLs and commerce, and replays one receipt', async () => {
	const key = randomUUID()
	const res = await edit(body(), key)
	expect(res.status).toBe(200)
	expect(res.body).toEqual({ product_id: id(2), revision: 1, operation_id: key })
	expect((await edit(body(), key)).body).toEqual(res.body)
	expect((await gate.readStamp()).revision).toBe(1)
	expect(await db().collection('products').findOne({})).toMatchObject({
		name: 'АВР новий',
		attributes_v2: [{ k: 'automatic', v: false }],
		description: { html: 'keep' }
	})
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) })
	).toMatchObject({
		name: 'АВР новий — 0 А',
		variant_value: 0,
		slug: 'avr-3',
		sku: 'FL-000003',
		price: 100,
		stock: 20,
		images: ['image'],
		promo_percent: 10
	})
	expect((await edit({ ...body(), name: 'different' }, key)).status).toBe(409)
	expect((await edit()).status).toBe(409)
})
it.each([
	[
		'number string',
		() => ({
			...body(),
			variants: [
				{ id: id(3), variant_value: '0' },
				{ id: id(4), variant_value: 32 }
			]
		})
	],
	['false string', () => ({ ...body(), attributes_v2: [{ k: 'automatic', v: 'false' }] })],
	[
		'duplicate value',
		() => ({
			...body(),
			variants: [
				{ id: id(3), variant_value: 32 },
				{ id: id(4), variant_value: 32 }
			]
		})
	],
	[
		'duplicate id',
		() => ({
			...body(),
			variants: [
				{ id: id(3), variant_value: 0 },
				{ id: id(3), variant_value: 32 }
			]
		})
	],
	['axis in attributes', () => ({ ...body(), attributes_v2: [{ k: 'current', v: 32 }] })],
	['unknown top level', () => ({ ...body(), price: 1 })],
	[
		'unknown nested',
		() => ({
			...body(),
			variants: [
				{ id: id(3), variant_value: 0, price: 1 },
				{ id: id(4), variant_value: 32 }
			]
		})
	],
	['multiple without axis', () => ({ ...body(), variant_axis: null })]
])('rejects %s without domain writes and leaves the gate usable', async (_name, payload) => {
	expect((await edit(payload())).status).toBe(400)
	expect((await gate.readStamp()).revision).toBe(0)
	expect((await db().collection('products').findOne({}))!.name).toBe('АВР')
})
it('rejects foreign, omitted and active SKU', async () => {
	expect((await edit({ ...body(), variants: [{ id: id(3), variant_value: 0 }] })).status).toBe(
		409
	)
	expect(
		(
			await edit({
				...body(),
				variants: [
					{ id: id(3), variant_value: 0 },
					{ id: id(8), variant_value: 32 }
				]
			})
		).status
	).toBe(409)
	// An active SKU may not appear in a draft category's edit as published: archived category.
	await db()
		.collection('categories')
		.updateOne({}, { $set: { status: 'archived' } })
	expect((await edit()).status).toBe(409)
	expect((await gate.readStamp()).revision).toBe(0)
})
it('refuses a dictionary colour on a SKU whose axis is not a colour axis', async () => {
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(3) }, { $set: { color_id: oid(9) } })
	const res = await edit()
	expect(res.status).toBe(409)
	expect((res.body as { details: { code: string } }).details.code).toBe('COLOR_ADAPTER_REQUIRED')
})
it('refuses partial reads while a catalog operation is open', async () => {
	await gate.acquire(randomUUID(), 'hash', 'owner', 0)
	expect(
		(
			await request(app.getHttpServer() as Server)
				.get(path)
				.set('x-test-role', 'ADMIN')
		).status
	).toBe(503)
})
/**
 * The operator's takeover of a save interrupted after its domain writes (audit 31.10.2026: the
 * writer leaves it `recovery_required`; `scripts/catalog-recover.cjs` does exactly this).
 */
async function takeOver(token: CatalogWriteToken) {
	expect(
		await db().collection<{ _id: string }>('catalog_control').findOne({ _id: 'catalog' })
	).toMatchObject({ phase: 'recovery_required' })
	const journal = new CatalogMutationJournal(db(), gate)
	const next = await gate.claimRecovery(token, 'operator', true)
	await journal.adoptRecovery(token, next)
	await gate.finishRecovery(token, next)
	return { journal, token: next }
}
it('rolls back names and typed fields after interrupted verification without undoing concurrent commerce', async () => {
	const key = randomUUID()
	const publish = jest
		.spyOn(CatalogWriteGate.prototype, 'publishVerified')
		.mockRejectedValueOnce(Error('simulated publication failure'))
	try {
		expect((await edit(body(), key)).status).toBe(503)
	} finally {
		publish.mockRestore()
	}
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(3) }, { $set: { price: 222, stock: 7 } })
	const plan = await db()
		.collection('catalog_mutation_plans')
		.findOne({ _id: key } as never)
	const recovery = await takeOver(plan!.token as CatalogWriteToken)
	await recovery.journal.execute(recovery.token, 'rollback')
	await gate.finishRolledBack(recovery.token)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) })
	).toMatchObject({ name: 'АВР — 16 А', variant_value: 16, price: 222, stock: 7, slug: 'avr-3' })
	expect((await new TypedProductWriter(db()).read(id(2))).name).toBe('АВР')
})
it('paginates category products without duplicates and rejects cursors after revision changes', async () => {
	await db()
		.collection('products')
		.insertMany(
			Array.from({ length: 30 }, (_, index) => ({
				_id: oid(index + 20),
				category_id: oid(1),
				name: `Product ${index}`
			}))
		)
	const get = (cursor?: string) =>
		request(app.getHttpServer() as Server)
			.get('/products/admin/typed-drafts')
			.set('x-test-role', 'ADMIN')
			.query({ category_id: id(1), ...(cursor ? { cursor } : {}) })
	const first = await get()
	expect(first.status).toBe(200)
	const page = first.body as { items: { id: string }[]; next_cursor: string }
	expect(page.items).toHaveLength(25)
	const second = await get(page.next_cursor)
	expect(second.status).toBe(200)
	const next = second.body as { items: { id: string }[]; next_cursor: null }
	expect(next.items).toHaveLength(6)
	expect(next.next_cursor).toBeNull()
	expect(new Set([...page.items, ...next.items].map(row => row.id)).size).toBe(31)
	expect((await get('bad')).status).toBe(400)
	await edit()
	expect((await get(page.next_cursor)).status).toBe(409)
})
it('numbers the pages with a total and searches by name over the whole category', async () => {
	await db()
		.collection('products')
		.insertMany(
			Array.from({ length: 30 }, (_, index) => ({
				_id: oid(index + 20),
				category_id: oid(1),
				name: index === 27 ? 'Kingroon PLA (Шовк)' : `Product ${index}`
			}))
		)
	const get = (query: Record<string, string>) =>
		request(app.getHttpServer() as Server)
			.get('/products/admin/typed-drafts')
			.set('x-test-role', 'ADMIN')
			.query({ category_id: id(1), ...query })
	type Page = { items: { id: string; name: string }[]; total: number }
	const first = (await get({ page: '1' })).body as Page
	const second = (await get({ page: '2' })).body as Page
	expect([first.items.length, second.items.length, first.total, second.total]).toEqual([
		25, 6, 31, 31
	])
	expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(31)
	expect(((await get({ page: '3' })).body as Page).items).toEqual([])
	// The name search spans every page, literally and case-insensitively (Cyrillic too).
	const found = (await get({ q: 'шовк)' })).body as Page
	expect(found).toMatchObject({ total: 1, items: [{ name: 'Kingroon PLA (Шовк)' }] })
	// «Product 2» and «Product 20»…«Product 29», without the renamed 27th.
	expect(((await get({ q: 'product 2', page: '1' })).body as Page).total).toBe(10)
	const invalid: Record<string, string>[] = [
		{ page: '0' },
		{ page: 'x' },
		{ q: '' },
		{ page: '1', cursor: 'abc' }
	]
	for (const query of invalid) expect((await get(query)).status).toBe(400)
})
it('supports removing the axis from a single SKU without changing its identity', async () => {
	await db()
		.collection('product_variants')
		.deleteOne({ _id: oid(4) })
	const result = await edit({
		...body(),
		variant_axis: null,
		variants: [{ id: id(3), variant_value: null }]
	})
	expect(result.status).toBe(200)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) })
	).toMatchObject({ name: 'АВР новий', variant_value: null, slug: 'avr-3', sku: 'FL-000003' })
})

async function detailBody() {
	const result = await new TypedProductWriter(db()).read(id(2))
	return {
		...body(),
		details: {
			...result.details,
			description: {
				html: '<p>Опис</p><script>alert(1)</script>',
				json: { ops: [{ insert: 'Опис\n' }] }
			},
			variants: result.details.variants.map(row => ({
				...row,
				images: ['https://example.com/first.webp', 'https://example.com/second.webp'],
				weight_g: 1200
			}))
		}
	}
}
it('saves sanitized description, ordered media and commerce; replay keeps identities and timestamps', async () => {
	const payload = await detailBody(),
		key = randomUUID()
	payload.details.variants[0].price = 125.5
	payload.details.variants[0].stock = 0
	expect((await edit(payload, key)).status).toBe(200)
	const row = await db()
		.collection('product_variants')
		.findOne({ _id: oid(3) })
	expect(row).toMatchObject({
		price: 125.5,
		stock: 0,
		weight_g: 1200,
		images: payload.details.variants[0].images,
		slug: 'avr-3',
		sku: 'FL-000003',
		promo_percent: 10
	})
	expect(row!.price_updated_at).toBeInstanceOf(Date)
	expect(
		(await db()
			.collection('products')
			.findOne({ _id: oid(2) }))!.description
	).toMatchObject({ html: '<p>Опис</p>' })
	expect((await edit(payload, key)).status).toBe(200)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) })
	).toEqual(row)
})
it("keeps the product's own purchase notice: plain text, omitted keeps it, null clears it", async () => {
	const stored = async () =>
		(await db()
			.collection('products')
			.findOne({ _id: oid(2) }))!.purchase_notice as unknown
	// Each save moves the catalogue revision: the next one is built from a fresh read.
	const fresh = async (notice?: unknown) => {
		const payload = await detailBody()
		const { revision } = await new TypedProductWriter(db()).read(id(2))
		const details: Record<string, unknown> = { ...payload.details }
		if (notice === undefined) delete details.purchase_notice
		else details.purchase_notice = notice
		return { ...payload, expected_revision: revision, details }
	}
	expect((await detailBody()).details.purchase_notice).toBeNull()
	expect(
		(await edit(await fresh({ title: 'Це <b>рефіл</b>', text: 'Без котушки.', badge: '  ' })))
			.status
	).toBe(200)
	// Owner, 2026-11-05: the notice is the product's, markup dropped, a blank badge is none.
	const notice = { title: 'Це рефіл', text: 'Без котушки.', badge: null }
	expect(await stored()).toEqual(notice)
	expect((await new TypedProductWriter(db()).read(id(2))).details.purchase_notice).toEqual(notice)
	// Another card saving its details without the notice keeps it.
	expect((await edit(await fresh())).status).toBe(200)
	expect(await stored()).toEqual(notice)
	expect((await edit(await fresh({ title: '', text: 'x', badge: null }))).status).toBe(400)
	expect((await edit(await fresh(null))).status).toBe(200)
	expect(await stored()).toBeNull()
})
it('rejects stale commerce snapshots before changing the name or description', async () => {
	const payload = await detailBody()
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(3) }, { $set: { stock: 7 } })
	const result = await edit(payload)
	expect(result.status).toBe(409)
	expect(result.body).toMatchObject({ details: { code: 'PRODUCT_DETAILS_CHANGED' } })
	expect(
		(await db()
			.collection('products')
			.findOne({ _id: oid(2) }))!.name
	).toBe('АВР')
	expect(
		(await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) }))!.stock
	).toBe(7)
	expect((await edit()).status).toBe(200)
})
it.each(['negative price', 'fractional stock', 'zero weight', 'unsafe image', 'duplicate id'])(
	'rejects invalid details: %s',
	async kind => {
		const payload = await detailBody()
		if (kind === 'negative price') payload.details.variants[0].price = -1
		if (kind === 'fractional stock') payload.details.variants[0].stock = 1.2
		if (kind === 'zero weight') payload.details.variants[0].weight_g = 0
		if (kind === 'unsafe image') payload.details.variants[0].images = ['javascript:alert(1)']
		if (kind === 'duplicate id') payload.details.variants[1].id = payload.details.variants[0].id
		expect((await edit(payload)).status).toBe(kind === 'duplicate id' ? 409 : 400)
		expect((await gate.readStamp()).revision).toBe(0)
	}
)
it('rollback refuses a concurrent edit to a changed commerce field', async () => {
	const payload = await detailBody(),
		key = randomUUID()
	payload.details.variants[0].price = 150
	let token: CatalogWriteToken | undefined
	const spy = jest
		.spyOn(CatalogWriteGate.prototype, 'publishVerified')
		.mockImplementationOnce(value => {
			token = value
			return Promise.reject(Error('lost publish'))
		})
	expect((await edit(payload, key)).status).toBe(503)
	spy.mockRestore()
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(3) }, { $set: { price: 222 } })
	// The changed price matches neither image: the takeover itself refuses to adopt the save.
	await expect(takeOver(token!)).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' })
	expect(
		(await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) }))!.price
	).toBe(222)
})

it('rolls back detail changes while preserving a concurrent unchanged stock field', async () => {
	const payload = await detailBody(),
		key = randomUUID()
	payload.details.variants[0].price = 150
	let token: CatalogWriteToken | undefined
	const spy = jest
		.spyOn(CatalogWriteGate.prototype, 'publishVerified')
		.mockImplementationOnce(value => {
			token = value
			return Promise.reject(Error('lost publish'))
		})
	expect((await edit(payload, key)).status).toBe(503)
	spy.mockRestore()
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(3) }, { $set: { stock: 9 } })
	const recovery = await takeOver(token!)
	await recovery.journal.execute(recovery.token, 'rollback')
	await gate.finishRolledBack(recovery.token)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) })
	).toMatchObject({ price: 100, stock: 9, images: ['image'], slug: 'avr-3' })
	expect(
		(await db()
			.collection('products')
			.findOne({ _id: oid(2) }))!.description
	).toEqual({ html: 'keep' })
})

async function lifecycleBody(
	variant_action: import('./typed-product').TypedProductEdit['variant_action']
) {
	const current = await new TypedProductWriter(db()).read(id(2))
	return {
		expected_revision: current.revision,
		name: current.name,
		attributes_v2: current.attributes_v2,
		variant_axis: current.variant_axis,
		variants: current.variants.map(row => ({ id: row.id, variant_value: row.variant_value })),
		variant_action
	}
}
async function prepareIdentities() {
	await db().collection('numbers').insertOne({ sku: 10 })
	await db().collection('product_variants').createIndex({ sku: 1 }, { unique: true })
	await db().collection('product_variants').createIndex({ slug: 1 }, { unique: true })
}
it('adds a single SKU with stable identity and replays without changing existing variants', async () => {
	await prepareIdentities()
	const previous = await db().collection('product_variants').find({}).sort({ _id: 1 }).toArray()
	const payload = await lifecycleBody({
			type: 'add',
			variant_value: 32,
			price: 1200,
			stock: 5,
			weight_g: 800
		}),
		key = randomUUID()
	expect((await edit(payload, key)).status).toBe(200)
	expect((await edit(payload, key)).status).toBe(200)
	expect(await db().collection('product_variants').countDocuments()).toBe(3)
	const created = await db().collection('product_variants').findOne({ sku: 'FL-000011' })
	expect(created).toMatchObject({
		name: 'АВР — 32 А',
		variant_value: 32,
		price: 1200,
		stock: 5,
		weight_g: 800,
		status: 'draft',
		slug: 'avr-32-a'
	})
	expect(
		await db()
			.collection('product_variants')
			.find({ _id: { $in: [oid(3), oid(4)] } })
			.sort({ _id: 1 })
			.toArray()
	).toEqual(previous)
	expect((await db().collection('numbers').findOne({}))!.sku).toBe(11)
})
it('archives and restores with the same URL, article, commerce and order references', async () => {
	const previous = await db()
		.collection('product_variants')
		.findOne({ _id: oid(3) })
	await db()
		.collection('orders')
		.insertOne({ items: [{ variant_id: oid(3), quantity: 1 }] })
	expect((await edit(await lifecycleBody({ type: 'archive', id: id(3) }))).status).toBe(200)
	const archived = await new TypedProductWriter(db()).read(id(2))
	expect(archived.variants.find(row => row.id === id(3))!.status).toBe('archived')
	expect((await edit(await lifecycleBody({ type: 'restore', id: id(3) }))).status).toBe(200)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(3) })
	).toEqual(previous)
	expect(
		await db()
			.collection('orders')
			.countDocuments({ 'items.variant_id': oid(3) })
	).toBe(1)
})
it('keeps an all-archived product readable and allows restoration', async () => {
	for (const n of [3, 4])
		expect((await edit(await lifecycleBody({ type: 'archive', id: id(n) }))).status).toBe(200)
	expect(
		(await new TypedProductWriter(db()).read(id(2))).variants.every(
			row => row.status === 'archived'
		)
	).toBe(true)
	expect((await edit(await lifecycleBody({ type: 'restore', id: id(4) }))).status).toBe(200)
})
it('does not reuse an archived variant value or consume a counter on validation failure', async () => {
	await prepareIdentities()
	expect((await edit(await lifecycleBody({ type: 'archive', id: id(3) }))).status).toBe(200)
	const duplicate = await edit(
		await lifecycleBody({ type: 'add', variant_value: 16, price: 10, stock: 0, weight_g: null })
	)
	expect(duplicate.status).toBe(400)
	expect(duplicate.body).toMatchObject({ details: { code: 'DUPLICATE_VARIANT_VALUE' } })
	expect((await db().collection('numbers').findOne({}))!.sku).toBe(10)
})
it('rejects restore of a draft and an action targeting another product', async () => {
	expect((await edit(await lifecycleBody({ type: 'restore', id: id(3) }))).status).toBe(409)
	expect((await edit(await lifecycleBody({ type: 'archive', id: id(99) }))).status).toBe(409)
	expect((await gate.readStamp()).revision).toBe(0)
})
it('rejects another SKU without an axis', async () => {
	await db()
		.collection('product_variants')
		.deleteOne({ _id: oid(4) })
	await db()
		.collection('products')
		.updateOne({ _id: oid(2) }, { $set: { variant_axis: null } })
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(3) }, { $set: { variant_value: null } })
	const result = await edit(
		await lifecycleBody({ type: 'add', variant_value: 32, price: 10, stock: 0, weight_g: null })
	)
	expect(result.status).toBe(400)
	expect(result.body).toMatchObject({ details: { code: 'VARIANT_AXIS_REQUIRED' } })
})
it('rolls back an interrupted addition without deleting the original product or reusing its reserved SKU', async () => {
	await prepareIdentities()
	let token: CatalogWriteToken | undefined
	const spy = jest
		.spyOn(CatalogWriteGate.prototype, 'publishVerified')
		.mockImplementationOnce(value => {
			token = value
			return Promise.reject(Error('stop'))
		})
	expect(
		await edit(
			await lifecycleBody({
				type: 'add',
				variant_value: 32,
				price: 10,
				stock: 0,
				weight_g: null
			})
		)
	).toMatchObject({ status: 503 })
	spy.mockRestore()
	const recovery = await takeOver(token!)
	await recovery.journal.execute(recovery.token, 'rollback')
	await gate.finishRolledBack(recovery.token)
	expect(
		await db()
			.collection('products')
			.countDocuments({ _id: oid(2) })
	).toBe(1)
	expect(await db().collection('product_variants').countDocuments()).toBe(2)
	expect((await db().collection('numbers').findOne({}))!.sku).toBe(11)
})
