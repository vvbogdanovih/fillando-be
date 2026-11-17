import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CategorySeoController, CategorySeoService } from './category-seo'

/** Managed SEO copy of v2 categories (Plan-0010 B09/F05): journal-backed, also on published ones. */
const id = (n: number) => n.toString(16).padStart(24, '0')
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const seo = {
	title: ' PLA філамент — Fillando ',
	description: 'Купити PLA',
	h1: 'PLA',
	intro_html: '<p>Вступ</p><script>x()</script>',
	bottom_html: '<p><br></p>'
}
async function save(category: number, value: object = seo, key = randomUUID()) {
	return request(server())
		.patch(`/categories/${id(category)}/admin/seo`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), seo: value })
}
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('category-seo')
	app = await createRbacApp({
		controllers: [CategorySeoController],
		providers: [
			CategorySeoService,
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
				_id: new mongo.ObjectId(id(1)),
				name: 'Філамент',
				slug: 'filament',
				kind: 'product',
				status: 'active',
				attribute_contract_version: 2,
				attribute_definitions: []
			},
			{
				_id: new mongo.ObjectId(id(2)),
				name: 'Архів',
				slug: 'archive',
				kind: 'group',
				status: 'archived',
				attribute_contract_version: 2,
				attribute_definitions: []
			},
			{
				_id: new mongo.ObjectId(id(3)),
				name: 'Легасі',
				slug: 'legacy',
				required_attributes: []
			}
		])
})

it('saves sanitized copy on a published category and replays the same key', async () => {
	const start = await revision()
	const key = randomUUID()
	const saved = await save(1, seo, key)
	expect(saved.status).toBe(200)
	expect(saved.body).toMatchObject({ category_id: id(1), revision: start + 1 })
	expect(
		(
			await db()
				.collection('categories')
				.findOne({ _id: new mongo.ObjectId(id(1)) })
		)?.seo
	).toEqual({
		title: 'PLA філамент — Fillando',
		description: 'Купити PLA',
		h1: 'PLA',
		intro_html: '<p>Вступ</p>',
		bottom_html: null
	})
	const replay = await request(server())
		.patch(`/categories/${id(1)}/admin/seo`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: start, seo })
	expect(replay.body).toEqual(saved.body)
	const read = await request(server())
		.get(`/categories/${id(1)}/admin/seo`)
		.set('x-test-role', 'ADMIN')
	expect(read.body).toMatchObject({ revision: start + 1, status: 'active', seo: { h1: 'PLA' } })
	expect((await save(1)).body).toMatchObject({ details: { code: 'SEO_UNCHANGED' } })
})

it('refuses archived and legacy categories, bad fields and non-admins', async () => {
	expect((await save(2)).body).toMatchObject({ details: { code: 'CATEGORY_SEO_UNAVAILABLE' } })
	expect((await save(3)).status).toBe(409)
	expect((await save(1, { ...seo, extra: 1 })).status).toBe(400)
	expect((await save(1, { ...seo, title: 'x'.repeat(301) })).status).toBe(400)
	expect((await save(99)).status).toBe(404)
	expect(
		(
			await request(server())
				.get(`/categories/${id(1)}/admin/seo`)
				.set('x-test-role', 'USER')
		).status
	).toBe(403)
	expect(await db().collection('catalog_control').findOne({})).toMatchObject({ phase: 'idle' })
})
