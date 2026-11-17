import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { ColorAdminController, ColorAdminService } from './color-admin'

/** The colour dictionary in the new admin, after the legacy `/colors` writes are interlocked. */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const color = (n: number) =>
	db()
		.collection('colors')
		.findOne({ _id: oid(n) })
const variant = (n: number) =>
	db()
		.collection('product_variants')
		.findOne({ _id: oid(n) })
const entry = {
	name_en: 'Black',
	name_uk: 'Чорний',
	family: 'black',
	hex_stops: ['#000000'],
	order: 1
}
async function call(
	method: 'post' | 'patch',
	path: string,
	body: object,
	key = randomUUID(),
	at?: number
) {
	return request(server())
		[method](`/colors${path}`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: at ?? (await revision()), ...body })
}

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('color-admin')
	app = await createRbacApp({
		controllers: [ColorAdminController],
		providers: [
			ColorAdminService,
			{ provide: getConnectionToken(), useValue: mongoose.connection }
		]
	})
})
afterAll(async () => {
	await app?.close()
	await dropTestDb(mongoose)
})
let revalidate: jest.SpyInstance, feed: jest.SpyInstance
beforeEach(async () => {
	revalidate = jest.spyOn(storefrontRevalidation, 'revalidate').mockImplementation(() => {})
	feed = jest.spyOn(feedRefresh, 'request').mockImplementation(() => {})
	await mongoose.connection.dropDatabase()
	await new CatalogWriteGate(db()).initialize()
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
	await db()
		.collection('colors')
		.insertMany([
			{ _id: oid(1), ...entry, slug: 'black', order: 0 },
			{
				_id: oid(2),
				name_en: 'White',
				name_uk: 'Білий',
				slug: 'white',
				family: 'white',
				hex_stops: ['#ffffff'],
				order: 1
			}
		])
	await db()
		.collection('products')
		.insertMany([
			{ _id: oid(10), name: 'Bambu PLA' },
			{ _id: oid(11), name: 'Sunlu PETG' }
		])
	await db()
		.collection('product_variants')
		.insertMany([
			{
				_id: oid(20),
				product_id: oid(10),
				color_id: oid(1),
				color_family: 'black',
				v_value: 'Black',
				slug: 'bambu-pla-black',
				name: 'Bambu PLA — Чорний (Black)'
			},
			{
				_id: oid(21),
				product_id: oid(11),
				color_id: oid(1),
				color_family: 'black',
				v_value: 'Black',
				slug: 'sunlu-petg-black',
				name: 'Sunlu PETG — Чорний (Black)'
			},
			{
				_id: oid(22),
				product_id: oid(11),
				color_id: oid(2),
				color_family: 'white',
				v_value: 'White',
				slug: 'sunlu-petg-white',
				name: 'Sunlu PETG — Білий (White)'
			}
		])
})
afterEach(() => jest.restoreAllMocks())

it('reads the dictionary with the revision and SKU counts, ADMIN only', async () => {
	const read = await request(server()).get('/colors/admin/entries').set('x-test-role', 'ADMIN')
	expect(read.status).toBe(200)
	expect(read.headers['cache-control']).toBe('no-store')
	expect(read.body).toMatchObject({
		revision: await revision(),
		colors: [
			{ _id: id(1), name_en: 'Black', variant_count: 2 },
			{ _id: id(2), name_en: 'White', variant_count: 1 }
		]
	})
	expect((await request(server()).get('/colors/admin/entries')).status).toBe(401)
	expect(
		(await request(server()).get('/colors/admin/entries').set('x-test-role', 'USER')).status
	).toBe(403)
})

it('adds a colour with a derived slug and replays the same key without a second one', async () => {
	const key = randomUUID(),
		at = await revision()
	const body = {
		color: {
			name_en: 'Bambu Green',
			name_uk: 'Зелений',
			family: 'green',
			hex_stops: ['#00AE42']
		}
	}
	const created = await call('post', '/admin/entries', body, key, at)
	expect(created.status).toBe(201)
	const colorId = (created.body as { color_id: string }).color_id
	expect(
		await db()
			.collection('colors')
			.findOne({ _id: new mongo.ObjectId(colorId) })
	).toMatchObject({ slug: 'bambu-green', hex_stops: ['#00ae42'], order: 0, family: 'green' })
	expect((await call('post', '/admin/entries', body, key, at)).body).toEqual(created.body)
	expect(await db().collection('colors').countDocuments()).toBe(3)
	const taken = await call('post', '/admin/entries', {
		color: { ...body.color, name_en: 'Black' }
	})
	expect(taken.status).toBe(409)
	expect((taken.body as { details: { code: string } }).details.code).toBe(
		'COLOR_IDENTITY_CONFLICT'
	)
	expect((await call('post', '/admin/entries', { color: { name_en: 'x' } })).status).toBe(400)
})

it('renames and re-families a colour together with its SKUs in one plan, keeping URLs', async () => {
	const at = await revision()
	const updated = await call('patch', `/${id(1)}/admin`, {
		color: { ...entry, name_uk: 'Графітовий', family: 'gray', slug: 'black' }
	})
	expect(updated.status).toBe(200)
	expect(await revision()).toBe(at + 1)
	expect(await color(1)).toMatchObject({ name_uk: 'Графітовий', family: 'gray', slug: 'black' })
	expect(await variant(20)).toMatchObject({
		name: 'Bambu PLA — Графітовий (Black)',
		color_family: 'gray',
		v_value: 'Black',
		slug: 'bambu-pla-black'
	})
	expect(await variant(21)).toMatchObject({ name: 'Sunlu PETG — Графітовий (Black)' })
	// Another colour's SKUs are not touched.
	expect(await variant(22)).toMatchObject({ name: 'Sunlu PETG — Білий (White)' })
	const same = await call('patch', `/${id(1)}/admin`, {
		color: { ...entry, name_uk: 'Графітовий', family: 'gray', slug: 'black' }
	})
	expect(same.status).toBe(409)
	expect((same.body as { details: { code: string } }).details.code).toBe('COLOR_UNCHANGED')
	expect(revalidate).toHaveBeenCalledWith('products', 'colour dictionary')
	expect(feed).toHaveBeenCalledWith('colour dictionary')
})

it('deletes only an unused colour, saying how many SKUs still use it', async () => {
	const used = await call('post', `/${id(1)}/admin/deletion`, {})
	expect(used.status).toBe(409)
	expect((used.body as { details: object }).details).toMatchObject({
		code: 'COLOR_IN_USE',
		count: 2
	})
	await db()
		.collection('product_variants')
		.deleteOne({ _id: oid(22) })
	const removed = await call('post', `/${id(2)}/admin/deletion`, {})
	expect(removed.status).toBe(200)
	expect(await color(2)).toBeNull()
	expect((await call('post', `/${id(9)}/admin/deletion`, {})).status).toBe(404)
})

it('stays closed while the new admin writes are disabled', async () => {
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: false } })
	const refused = await call('patch', `/${id(1)}/admin`, { color: { ...entry, name_uk: 'X' } })
	expect(refused.status).toBe(503)
	expect(await color(1)).toMatchObject({ name_uk: 'Чорний' })
})
