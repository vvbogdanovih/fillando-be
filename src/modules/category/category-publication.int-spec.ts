import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { CatalogMutationJournal } from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CategoryPublicationController, CategoryPublicationService } from './category-publication'
import { CategoryPublicReadService } from './category-public-read.service'

const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const revision = async () =>
	(await db()
		.collection('catalog_control')
		.findOne({ _id: 'catalog' } as never))!.revision as number
const status = async (collection: string, n: number) =>
	(await db()
		.collection(collection)
		.findOne({ _id: oid(n) }))!.status as string
function send(
	category: number,
	payload: object,
	key: string = randomUUID(),
	role: string | null = 'ADMIN'
) {
	const req = request(app.getHttpServer() as Server)
		.post(`/categories/${id(category)}/admin/publication`)
		.set('Idempotency-Key', key)
	if (role) req.set('x-test-role', role)
	return req.send(payload) as Promise<{ status: number; body: Body }>
}
type Body = {
	revision?: number
	changed_variants?: number | null
	details: { code: string }
	[key: string]: unknown
}
const definition = {
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
}
const required = {
	...definition,
	key: 'poles',
	label: 'Полюси',
	value_type: 'number',
	unit: null,
	filter_enabled: false,
	filter_type: null
}
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('category-publication')
	app = await createRbacApp({
		controllers: [CategoryPublicationController],
		providers: [
			CategoryPublicationService,
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			{
				provide: APP_PIPE,
				useValue: new ValidationPipe({ whitelist: true, transform: true })
			}
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
	const node = (n: number, extra: object) => ({
		_id: oid(n),
		name: `Node ${n}`,
		slug: `node-${n}`,
		order: 0,
		status: 'draft',
		attribute_contract_version: 2,
		attribute_definitions: [],
		...extra
	})
	await db()
		.collection('categories')
		.insertMany([
			node(1, { kind: 'group', parent_id: null }),
			node(2, {
				kind: 'product',
				parent_id: oid(1),
				attribute_definitions: [definition, required]
			})
		])
	const description = { html: '<p>Готовий опис</p>', json: {} }
	await db()
		.collection('products')
		.insertMany([
			{
				_id: oid(10),
				name: 'Ready',
				category_id: oid(2),
				attributes_v2: [{ k: 'poles', v: 4 }],
				variant_axis: { key: 'current' },
				description
			},
			// Missing a required characteristic and the description: stays a draft.
			{
				_id: oid(11),
				name: 'Incomplete',
				category_id: oid(2),
				attributes_v2: [],
				variant_axis: { key: 'current' }
			}
		])
	const sku = (n: number, product: number, value: number, state = 'draft') => ({
		_id: oid(n),
		product_id: oid(product),
		category_id: oid(2),
		name: `SKU ${n}`,
		slug: `sku-${n}`,
		sku: `FL-${n}`,
		variant_value: value,
		status: state,
		price: 100,
		stock: 2,
		images: ['https://example.com/a.jpg']
	})
	await db()
		.collection('product_variants')
		.insertMany([
			sku(20, 10, 16),
			sku(21, 10, 32),
			sku(22, 10, 63, 'archived'),
			sku(23, 11, 16)
		])
})

it('requires a public parent, then publishes the group and the ready products of the category', async () => {
	const blocked = await send(2, { action: 'publish', expected_revision: 0 })
	expect(blocked.status).toBe(409)
	expect(blocked.body.details.code).toBe('CATEGORY_PARENT_NOT_PUBLIC')
	expect(await revision()).toBe(0)

	const group = await send(1, { action: 'publish', expected_revision: 0 })
	expect(group.status).toBe(201)
	expect(group.body).toMatchObject({ revision: 1, changed_variants: 0, skipped_products: [] })

	const key = randomUUID()
	const category = await send(2, { action: 'publish', expected_revision: 1 }, key)
	expect(category.status).toBe(201)
	expect(category.body).toMatchObject({
		revision: 2,
		changed_variants: 2,
		skipped_products: [
			{
				id: id(11),
				name: 'Incomplete',
				issues: expect.arrayContaining([
					'REQUIRED_ATTRIBUTE',
					'DESCRIPTION_REQUIRED'
				]) as unknown
			}
		]
	})
	expect(await status('categories', 2)).toBe('active')
	expect([await status('product_variants', 20), await status('product_variants', 21)]).toEqual([
		'active',
		'active'
	])
	expect(await status('product_variants', 22)).toBe('archived')
	expect(await status('product_variants', 23)).toBe('draft')

	// Same key and body: the stored receipt, no second write.
	const replay = await send(2, { action: 'publish', expected_revision: 1 }, key)
	expect(replay.body).toMatchObject({ revision: 2, changed_variants: null })
	expect(await revision()).toBe(2)
	const reused = await send(2, { action: 'unpublish', expected_revision: 2 }, key)
	expect(reused.status).toBe(409)
	expect(reused.body.details.code).toBe('IDEMPOTENCY_KEY_REUSED')

	const visible = await new CategoryPublicReadService(mongoose.connection).findVisibleTree()
	expect(visible.map(row => row.slug)).toEqual(['node-1', 'node-2'])
})

const manyReadySkus = (count: number) =>
	db()
		.collection('product_variants')
		.insertMany(
			Array.from({ length: count }, (_, n) => ({
				_id: oid(1000 + n),
				product_id: oid(10),
				category_id: oid(2),
				name: `SKU ${1000 + n}`,
				slug: `sku-${1000 + n}`,
				sku: `FL-${1000 + n}`,
				variant_value: 1000 + n,
				status: 'draft',
				price: 100,
				stock: 2,
				images: ['https://example.com/a.jpg']
			}))
		)
const activeSkus = () => db().collection('product_variants').countDocuments({ status: 'active' })
it('publishes over the journal limit in parts: SKUs first, the category last (P13)', async () => {
	expect((await send(1, { action: 'publish', expected_revision: await revision() })).status).toBe(
		201
	)
	// 2 + 1100 ready draft SKUs: more than one operation holds (500 records).
	await manyReadySkus(1100)
	const before = await revision()
	const published = await send(2, { action: 'publish', expected_revision: before })
	expect(published.status).toBe(201)
	expect(published.body).toMatchObject({ changed_variants: 1102 })
	// Three operations: two parts of SKUs, then the category with the rest.
	expect(published.body.revision).toBe(before + 3)
	expect(await revision()).toBe(before + 3)
	expect(await status('categories', 2)).toBe('active')
	expect(await activeSkus()).toBe(1102)

	const hidden = await send(2, { action: 'unpublish', expected_revision: before + 3 })
	expect(hidden.status).toBe(201)
	expect(hidden.body).toMatchObject({ changed_variants: 1102, revision: before + 6 })
	expect(await status('categories', 2)).toBe('draft')
	expect(await activeSkus()).toBe(0)
})
it('a publication stopped between parts leaves the category hidden; publishing again finishes it (P13)', async () => {
	await send(1, { action: 'publish', expected_revision: await revision() })
	await manyReadySkus(700)
	const before = await revision()
	// The second operation (the category with the rest) stops before its first write.
	let calls = 0
	// eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with its own receiver
	const original = CatalogMutationJournal.prototype.prepare
	const spy = jest
		.spyOn(CatalogMutationJournal.prototype, 'prepare')
		.mockImplementation(async function (this: CatalogMutationJournal, ...args) {
			calls++
			if (calls === 2) throw new Error('process stopped')
			await original.apply(this, args)
		})
	const stopped = await send(2, { action: 'publish', expected_revision: before })
	spy.mockRestore()
	expect(stopped.status).toBeGreaterThanOrEqual(500)
	// The first part is written; the category — and so every SKU — is still hidden.
	expect(await status('categories', 2)).toBe('draft')
	expect(await activeSkus()).toBe(500)
	// The admin publishes again (a new request): planned from where the part left off.
	const finished = await send(2, { action: 'publish', expected_revision: before + 1 })
	expect(finished.status).toBe(201)
	expect(await status('categories', 2)).toBe('active')
	expect(await activeSkus()).toBe(702)
})
it('unpublishes leaf first and returns its SKUs to draft; refuses stale revisions and a disabled flag', async () => {
	await send(1, { action: 'publish', expected_revision: 0 })
	await send(2, { action: 'publish', expected_revision: 1 })
	const parent = await send(1, { action: 'unpublish', expected_revision: 2 })
	expect(parent.status).toBe(409)
	expect(parent.body.details.code).toBe('CATEGORY_HAS_ACTIVE_CHILDREN')
	const stale = await send(2, { action: 'unpublish', expected_revision: 1 })
	expect(stale.status).toBe(409)
	expect(stale.body.details.code).toBe('CATEGORY_REVISION_CONFLICT')

	const leaf = await send(2, { action: 'unpublish', expected_revision: 2 })
	expect(leaf.status).toBe(201)
	expect(leaf.body).toMatchObject({ revision: 3, changed_variants: 2 })
	expect(await status('categories', 2)).toBe('draft')
	expect(await status('product_variants', 20)).toBe('draft')
	expect(await status('product_variants', 22)).toBe('archived')

	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: false } })
	const disabled = await send(1, { action: 'unpublish', expected_revision: 3 })
	expect(disabled.status).toBe(503)
	expect(disabled.body.details.code).toBe('CATALOG_DRAFT_WRITES_DISABLED')
	expect(await revision()).toBe(3)
})

it('is ADMIN-only and validates the command before touching the gate', async () => {
	expect(
		(await send(1, { action: 'publish', expected_revision: 0 }, randomUUID(), null)).status
	).toBe(401)
	expect(
		(await send(1, { action: 'publish', expected_revision: 0 }, randomUUID(), 'USER')).status
	).toBe(403)
	const invalid = await send(1, { action: 'delete', expected_revision: 0 })
	expect(invalid.status).toBe(400)
	expect(await revision()).toBe(0)
	const control = await db().collection('catalog_control').findOne({})
	expect(control).toMatchObject({ phase: 'idle' })
})

it('re-publishes colour-axis SKUs (dictionary id on every SKU) after an unpublish', async () => {
	// The migrated filament: a colour axis whose SKUs carry the dictionary id as their value.
	const colour = {
		...definition,
		key: 'color',
		label: 'Колір',
		value_type: 'string',
		unit: null,
		// A variation is built on a required characteristic only (owner, 2026-11-06).
		is_required: true,
		filter_enabled: false,
		filter_type: null,
		semantic: 'color'
	}
	await db()
		.collection('categories')
		.updateOne({ _id: oid(2) }, { $set: { attribute_definitions: [colour, required] } })
	const black = oid(90),
		white = oid(91)
	await db()
		.collection('products')
		.updateOne({ _id: oid(10) }, { $set: { variant_axis: { key: 'color' } } })
	await db()
		.collection('product_variants')
		.updateOne(
			{ _id: oid(20) },
			{ $set: { variant_value: String(black), color_id: black, color_family: 'black' } }
		)
	await db()
		.collection('product_variants')
		.updateOne(
			{ _id: oid(21) },
			{ $set: { variant_value: String(white), color_id: white, color_family: 'white' } }
		)
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(22) }, { $set: { variant_value: String(oid(92)) } })
	expect((await send(1, { action: 'publish', expected_revision: 0 })).status).toBe(201)
	const first = await send(2, { action: 'publish', expected_revision: 1 })
	expect(first.body).toMatchObject({ changed_variants: 2 })
	expect((first.body.skipped_products as { id: string }[]).map(product => product.id)).toEqual([
		id(11)
	])
	expect((await send(2, { action: 'unpublish', expected_revision: 2 })).status).toBe(201)
	expect(await status('product_variants', 20)).toBe('draft')
	const again = await send(2, { action: 'publish', expected_revision: 3 })
	expect(again.body).toMatchObject({ changed_variants: 2 })
	expect([await status('product_variants', 20), await status('product_variants', 21)]).toEqual([
		'active',
		'active'
	])
	// A SKU whose stored value no longer names its colour is not published blindly.
	await send(2, { action: 'unpublish', expected_revision: 4 })
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(21) }, { $set: { variant_value: String(black) } })
	const mismatch = await send(2, { action: 'publish', expected_revision: 5 })
	expect(mismatch.body.skipped_products).toContainEqual(
		expect.objectContaining({ id: id(10), issues: ['COLOR_AXIS_MISMATCH'] })
	)
})
