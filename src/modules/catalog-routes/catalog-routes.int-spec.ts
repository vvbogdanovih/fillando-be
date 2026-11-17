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
import { CatalogRoutesController, CatalogRoutesService } from './catalog-routes.controller'

/** Redirect-backed address changes and old-address resolution (Plan-0010 B07). */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
async function change(kind: 'variants' | 'categories' | 'landings', n: number, slug: string) {
	return request(server())
		.post(`/routes/${kind}/${id(n)}/slug-change`)
		.set('Idempotency-Key', randomUUID())
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), slug })
}
const resolve = (path: string) => request(server()).get('/routes/resolve').query({ path })

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('catalog-routes')
	app = await createRbacApp({
		controllers: [CatalogRoutesController],
		providers: [
			CatalogRoutesService,
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
	const v2 = { attribute_contract_version: 2, attribute_definitions: [], parent_id: null }
	await db()
		.collection('categories')
		.insertMany([
			{
				_id: oid(1),
				name: 'Філамент',
				slug: 'filament',
				kind: 'product',
				status: 'active',
				order: 0,
				...v2
			},
			{
				_id: oid(2),
				name: 'Чернетка',
				slug: 'drafts',
				kind: 'product',
				status: 'draft',
				order: 1,
				...v2
			}
		])
	await db()
		.collection('landings')
		.insertMany([
			{
				_id: oid(40),
				category_id: oid(1),
				slug: 'pla',
				status: 'active',
				contract_version: 2,
				filters_v2: {}
			}
		])
	await db()
		.collection('products')
		.insertOne({ _id: oid(10), name: 'PLA', category_id: oid(1) })
	await db().collection('product_variants').createIndex({ slug: 1 }, { unique: true })
	await db()
		.collection('product_variants')
		.insertMany([
			{
				_id: oid(20),
				product_id: oid(10),
				category_id: oid(1),
				slug: 'pla-black',
				status: 'active'
			},
			{
				_id: oid(21),
				product_id: oid(10),
				category_id: oid(1),
				slug: 'pla-white',
				status: 'active'
			},
			{
				_id: oid(22),
				product_id: oid(10),
				category_id: oid(2),
				slug: 'hidden-sku',
				status: 'draft'
			}
		])
})

it('reads one catalogue state: 503 with Retry-After during a write or a change mid-read (P05)', async () => {
	expect((await change('variants', 20, 'pla-black-v2')).status).toBe(200)
	const phase = (value: string) =>
		db()
			.collection<{ _id: string }>('catalog_control')
			.updateOne({ _id: 'catalog' }, { $set: { phase: value } })
	await phase('writing')
	const busy = await resolve('/products/pla-black')
	expect(busy.status).toBe(503)
	expect(busy.headers).toMatchObject({ 'retry-after': '5', 'cache-control': 'no-store' })
	expect(busy.body).toMatchObject({ details: { code: 'CATALOG_MAINTENANCE' } })
	await phase('idle')
	// A write lands while the address is being resolved: refused, not answered from two states.
	const reader = app.get(CategoryPublicReadService)
	const spy = jest.spyOn(reader, 'findVisibleTree').mockImplementationOnce(async () => {
		await db()
			.collection<{ _id: string }>('catalog_control')
			.updateOne({ _id: 'catalog' }, { $inc: { revision: 1 } })
		// This one-off implementation is used up before it runs: the call reaches the real read.
		return reader.findVisibleTree()
	})
	const changed = await resolve('/products/pla-black')
	spy.mockRestore()
	expect(changed.status).toBe(503)
	expect(changed.headers).toMatchObject({ 'retry-after': '5' })
	expect(changed.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
	expect((await resolve('/products/pla-black')).body).toMatchObject({
		target_path: '/products/pla-black-v2'
	})
})
it('changes a SKU address, redirects the old one and never chains', async () => {
	expect((await change('variants', 20, 'pla-black-v2')).status).toBe(200)
	expect((await change('variants', 20, 'pla-black-v3')).status).toBe(200)
	for (const old of ['/products/pla-black', '/products/pla-black-v2'])
		expect((await resolve(old)).body).toEqual({
			kind: 'redirect',
			path: old,
			target_path: '/products/pla-black-v3',
			status: 301
		})
	expect(
		await db()
			.collection('product_variants')
			.findOne({ _id: oid(20) })
	).toMatchObject({ slug: 'pla-black-v3' })
	// Back to an old address: the own alias is reclaimed, the current one becomes an alias.
	expect((await change('variants', 20, 'pla-black')).status).toBe(200)
	expect((await resolve('/products/pla-black')).status).toBe(404)
	expect((await resolve('/products/pla-black-v3')).body).toMatchObject({
		target_path: '/products/pla-black'
	})
	// Another SKU's address or its old alias cannot be taken.
	expect((await change('variants', 21, 'pla-black')).body).toMatchObject({
		details: { code: 'ROUTE_PATH_TAKEN' }
	})
	expect((await change('variants', 21, 'pla-black-v2')).body).toMatchObject({
		details: { code: 'ROUTE_PATH_TAKEN' }
	})
	const badSlug = await change('variants', 21, 'Bad Slug')
	expect(badSlug.status).toBe(400)
	expect(badSlug.body).toMatchObject({ details: { code: 'INVALID_SLUG' } })
	// A wrong body is not a wrong address (audit 11.11).
	for (const body of [
		{ slug: 'pla-ok' },
		{ expected_revision: await revision(), slug: 'pla-ok', x: 1 }
	]) {
		const response = await request(server())
			.post(`/routes/variants/${id(21)}/slug-change`)
			.set('Idempotency-Key', randomUUID())
			.set('x-test-role', 'ADMIN')
			.send(body)
		expect(response.status).toBe(400)
		expect(response.body).toMatchObject({ details: { code: 'INVALID_ROUTE_FIELDS' } })
	}
	expect(await db().collection('catalog_control').findOne({})).toMatchObject({ phase: 'idle' })
})

it('moves a category with its landings and resolves only public targets', async () => {
	expect((await change('categories', 1, 'plastyk')).status).toBe(200)
	expect((await resolve('/filament')).body).toMatchObject({ target_path: '/plastyk' })
	expect((await resolve('/filament/pla')).body).toMatchObject({ target_path: '/plastyk/pla' })
	expect((await change('landings', 40, 'pla-filament')).status).toBe(200)
	// The landing's oldest address still lands on its current one, in one hop.
	expect((await resolve('/filament/pla')).body).toMatchObject({
		target_path: '/plastyk/pla-filament'
	})
	expect((await resolve('/plastyk/pla')).body).toMatchObject({
		target_path: '/plastyk/pla-filament'
	})
	for (const slug of ['admin', 'catalog', 'products'])
		expect((await change('categories', 1, slug)).body).toMatchObject({
			details: { code: 'ROUTE_PATH_RESERVED' }
		})
	expect((await change('categories', 2, 'plastyk')).body).toMatchObject({
		details: { code: 'ROUTE_PATH_TAKEN' }
	})
	// A draft category's old address is not a redirect to a page that does not exist.
	expect((await change('categories', 2, 'drafts-2')).status).toBe(200)
	expect((await resolve('/drafts')).status).toBe(404)
	expect((await change('variants', 22, 'hidden-sku-2')).status).toBe(200)
	expect((await resolve('/products/hidden-sku')).status).toBe(404)
	expect((await resolve('/unknown')).status).toBe(404)
	expect((await resolve('../etc')).status).toBe(400)
})

it('is ADMIN-only for changes and closed while admin writes are off', async () => {
	expect(
		(
			await request(server())
				.post(`/routes/variants/${id(20)}/slug-change`)
				.set('Idempotency-Key', randomUUID())
				.set('x-test-role', 'USER')
				.send({ expected_revision: 0, slug: 'x' })
		).status
	).toBe(403)
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: false } })
	expect((await change('variants', 20, 'pla-black-v2')).status).toBe(503)
})
