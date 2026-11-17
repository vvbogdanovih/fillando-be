import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { CategoryTreeWriter } from '../category/category-tree-writer'
import {
	STOREFRONT_CONTENT_DEFAULTS,
	StorefrontSettingsController,
	StorefrontSettingsService
} from './storefront-settings'

/**
 * Storefront settings (Plan-0010 B09, TD-0015): the home page's copy, references, journal, public
 * projection of visible targets.
 */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
async function save(body: object, key = randomUUID()) {
	return request(server())
		.patch('/storefront-settings')
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), ...body })
}
const settings = {
	...STOREFRONT_CONTENT_DEFAULTS,
	collections: [
		{ title: 'PLA', category_id: id(1), landing_id: id(40) },
		{ title: 'Чернетка', category_id: id(3), landing_id: null },
		{ title: 'Група', category_id: id(2), landing_id: null }
	]
}
const category = (n: number, extra: object) => ({
	_id: oid(n),
	name: `Категорія ${n}`,
	slug: `category-${n}`,
	parent_id: null,
	order: n,
	attribute_contract_version: 2,
	attribute_definitions: [],
	...extra
})
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('storefront-settings')
	app = await createRbacApp({
		controllers: [StorefrontSettingsController],
		providers: [
			StorefrontSettingsService,
			{
				provide: CategoryPublicReadService,
				useFactory: () => new CategoryPublicReadService(mongoose.connection)
			},
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			// The read barrier, as the app registers it (P05).
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor }
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
			category(1, { kind: 'product', status: 'active', image: 'https://example.com/f.png' }),
			category(2, { kind: 'group', status: 'active' }),
			category(3, { kind: 'product', status: 'draft' }),
			category(4, { kind: 'product', status: 'archived' })
		])
	await db()
		.collection('landings')
		.insertOne({
			_id: oid(40),
			category_id: oid(1),
			slug: 'pla',
			status: 'active',
			contract_version: 2,
			filters_v2: {
				attributes: [{ key: 'polymer', values: ['PLA'] }],
				category_ids: [],
				brand_ids: [],
				color_families: []
			}
		})
})

it('reads one catalogue state: 503 with Retry-After during a write or a change mid-read (P05)', async () => {
	expect((await save(settings)).status).toBe(200)
	const phase = (value: string) =>
		db()
			.collection<{ _id: string }>('catalog_control')
			.updateOne({ _id: 'catalog' }, { $set: { phase: value } })
	await phase('writing')
	const busy = await request(server()).get('/storefront-settings')
	expect(busy.status).toBe(503)
	expect(busy.headers).toMatchObject({ 'retry-after': '5', 'cache-control': 'no-store' })
	expect(busy.body).toMatchObject({ details: { code: 'CATALOG_MAINTENANCE' } })
	await phase('idle')
	const reader = app.get(CategoryPublicReadService)
	const spy = jest.spyOn(reader, 'findVisibleTree').mockImplementationOnce(async () => {
		await db()
			.collection<{ _id: string }>('catalog_control')
			.updateOne({ _id: 'catalog' }, { $inc: { revision: 1 } })
		// This one-off implementation is used up before it runs: the call reaches the real read.
		return reader.findVisibleTree()
	})
	const changed = await request(server()).get('/storefront-settings')
	spy.mockRestore()
	expect(changed.status).toBe(503)
	expect(changed.headers).toMatchObject({ 'retry-after': '5' })
	expect(changed.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
	expect((await request(server()).get('/storefront-settings')).status).toBe(200)
})
it('saves settings through the journal and projects only visible targets', async () => {
	const start = await revision()
	const saved = await save(settings)
	expect(saved.status).toBe(200)
	expect(saved.body).toMatchObject({ revision: start + 1 })
	const admin = await request(server())
		.get('/storefront-settings/admin')
		.set('x-test-role', 'ADMIN')
	expect(admin.body).toMatchObject({ revision: start + 1, ...STOREFRONT_CONTENT_DEFAULTS })
	expect((admin.body as { collections: { id: string }[] }).collections[0].id).toMatch(
		/^[0-9a-f-]{36}$/
	)
	const published = (await request(server()).get('/storefront-settings')).body as unknown
	expect(published).toEqual({
		...STOREFRONT_CONTENT_DEFAULTS,
		// The draft category's collection is not shown; the landing collection links the landing.
		collections: [
			{
				id: expect.any(String) as unknown,
				title: 'PLA',
				category_id: id(1),
				path: '/category-1/pla',
				filters: expect.objectContaining({
					attributes: [{ key: 'polymer', values: ['PLA'] }]
				}) as unknown
			},
			{
				id: expect.any(String) as unknown,
				title: 'Група',
				category_id: id(2),
				path: '/category-2',
				filters: null
			}
		]
	})
	// Keeping the collection ids, the same settings are unchanged.
	const again = await save({
		...settings,
		collections: (admin.body as { collections: object[] }).collections
	})
	expect(again.body).toMatchObject({ details: { code: 'SETTINGS_UNCHANGED' } })
	// A referenced category cannot be deleted from under the settings.
	await db()
		.collection('categories')
		.updateOne({ _id: oid(2) }, { $set: { status: 'draft' } })
	await expect(
		new CategoryTreeWriter(db()).deleteDraft(
			{ operationId: randomUUID(), ownerId: 'test', expectedRevision: await revision() },
			id(2)
		)
	).rejects.toThrow('CATEGORY_IN_USE')
})

it('refuses unknown, archived and legacy categories and foreign landings', async () => {
	for (const body of [
		{ ...settings, collections: [{ title: 'X', category_id: id(4) }] },
		{ ...settings, collections: [{ title: 'X', category_id: id(99) }] },
		{ ...settings, collections: [{ title: 'X', category_id: id(3), landing_id: id(40) }] }
	])
		expect((await save(body)).status).toBe(409)
	expect(
		(await save({ ...settings, collections: [{ title: '', category_id: id(1) }] })).status
	).toBe(400)
	// The /catalog intro is the storefront's own copy, not a setting (owner, 2026-11-03).
	expect((await save({ ...settings, catalog_intro_html: '<p>Вітрина</p>' })).status).toBe(400)
	expect(
		(await request(server()).patch('/storefront-settings').set('x-test-role', 'USER').send({}))
			.status
	).toBe(403)
	expect(await db().collection('storefront_settings').countDocuments()).toBe(0)
	// Without settings the home page's copy is the default one, and there are no collections.
	expect((await request(server()).get('/storefront-settings')).body).toEqual({
		...STOREFRONT_CONTENT_DEFAULTS,
		collections: []
	})
})

it('keeps the home page copy as plain text, buttons on this site only (TD-0015)', async () => {
	const { banner, side_promo, band } = STOREFRONT_CONTENT_DEFAULTS
	for (const body of [
		// a button leaving the site, or a script
		{ ...settings, banner: { ...banner, button_href: 'https://evil.example' } },
		{ ...settings, banner: { ...banner, button_href: '//evil.example' } },
		// a backslash: browsers resolve `/\host` as `//host`
		{ ...settings, banner: { ...banner, button_href: '/\\evil.example' } },
		{ ...settings, band: { ...band!, button_href: '/catalog\\..\\\\evil.example' } },
		{ ...settings, band: { ...band!, button_href: 'javascript:alert(1)' } },
		// the highlighted part must be a part of the title
		{ ...settings, banner: { ...banner, accent: 'чогось іншого' } },
		// a link card needs its link, the form card has none
		{ ...settings, side_promo: { ...side_promo, action: 'link', button_href: null } },
		{ ...settings, side_promo: { ...side_promo, button_href: '/opt' } },
		{ ...settings, strip: ['1', '2', '3', '4', '5'] },
		{ ...settings, banner: { ...banner, title: '' } },
		// the home page's tiles are gone
		{ ...settings, home_category_ids: [id(1)] }
	])
		expect((await save(body)).status).toBe(400)
	const saved = await save({
		...settings,
		strip: ['Доставка <b>щодня</b>'],
		banner: { ...banner, title: 'Новий сезон', accent: '', eyebrow: '' },
		band: null
	})
	expect(saved.status).toBe(200)
	expect((await request(server()).get('/storefront-settings')).body).toMatchObject({
		strip: ['Доставка щодня'],
		banner: { title: 'Новий сезон', accent: '' },
		band: null
	})
})

it('drops the old home page tiles on the next save', async () => {
	await db()
		.collection('storefront_settings')
		.insertOne({
			_id: new mongo.ObjectId('00000000000000000000aa01'),
			home_category_ids: [oid(1)],
			collections: []
		})
	// Nothing else changed, yet the save goes through: it removes the stale field.
	expect((await save({ ...STOREFRONT_CONTENT_DEFAULTS, collections: [] })).status).toBe(200)
	const stored = await db().collection('storefront_settings').findOne({})
	expect(stored).not.toHaveProperty('home_category_ids')
	expect(stored).toMatchObject({ banner: STOREFRONT_CONTENT_DEFAULTS.banner })
})

it('keeps a curated list of products and shows only the visible ones', async () => {
	await db()
		.collection('products')
		.insertMany([
			{ _id: oid(50), name: 'Видимий', category_id: oid(1) },
			{ _id: oid(51), name: 'У чернетці', category_id: oid(3) },
			{ _id: oid(52), name: 'В архівній', category_id: oid(4) }
		])
	const list = { title: 'Вибір магазину', product_ids: [id(51), id(50)] }
	const saved = await save({ ...settings, collections: [list] })
	expect(saved.status).toBe(200)
	const admin = await request(server())
		.get('/storefront-settings/admin')
		.set('x-test-role', 'ADMIN')
	expect((admin.body as { collections: unknown }).collections).toEqual([
		{
			id: expect.any(String) as unknown,
			title: 'Вибір магазину',
			category_id: null,
			landing_id: null,
			product_ids: [id(51), id(50)]
		}
	])
	// The draft category's product is not shown; the list keeps the admin's order otherwise.
	expect(
		((await request(server()).get('/storefront-settings')).body as { collections: unknown })
			.collections
	).toEqual([
		{
			id: expect.any(String) as unknown,
			title: 'Вибір магазину',
			category_id: null,
			path: null,
			filters: { product_ids: [id(50)] }
		}
	])
	// One source per collection, products of a v2 category that is not archived, each once.
	for (const collection of [
		{ ...list, category_id: id(1) },
		{ title: 'Порожня', product_ids: [] }
	])
		expect((await save({ ...settings, collections: [collection] })).status).toBe(400)
	for (const [product_ids, code] of [
		[[id(52)], 'SETTINGS_PRODUCT_INVALID'],
		[[id(99)], 'SETTINGS_PRODUCT_INVALID'],
		[[id(50), id(50)], 'SETTINGS_DUPLICATE_PRODUCT']
	] as const) {
		const res = await save({ ...settings, collections: [{ ...list, product_ids }] })
		expect([res.status, (res.body as { details: { code: string } }).details.code]).toEqual([
			409,
			code
		])
	}
})
