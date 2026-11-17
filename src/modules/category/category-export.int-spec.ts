import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CategoryExportController, CategoryExportService } from './category-export'

/** The Google taxonomy of v2 product categories (Plan-0010 B10): journal-backed. */
const id = (n: number) => n.toString(16).padStart(24, '0')
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const body = (extra: object = {}) => ({
	google_product_category: { id: 500000, path: 'Hardware > Power' },
	...extra
})
async function save(category: number, value: object = body()) {
	return request(server())
		.patch(`/categories/${id(category)}/admin/export`)
		.set('Idempotency-Key', randomUUID())
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), ...value })
}
const definition = (key: string) => ({
	key,
	label: key,
	value_type: 'string',
	unit: null,
	is_required: false,
	multiple: false,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	semantic: 'generic',
	options: []
})
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('category-export')
	app = await createRbacApp({
		controllers: [CategoryExportController],
		providers: [
			CategoryExportService,
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
				name: 'АВР',
				slug: 'avr',
				kind: 'product',
				status: 'active',
				attribute_contract_version: 2,
				attribute_definitions: [definition('current'), definition('poles')],
				google_product_category: null
			},
			{
				_id: new mongo.ObjectId(id(2)),
				name: 'Група',
				slug: 'group',
				kind: 'group',
				status: 'active',
				attribute_contract_version: 2,
				attribute_definitions: []
			}
		])
})

it('saves the taxonomy through the journal and reads it back', async () => {
	const start = await revision()
	const saved = await save(1)
	expect(saved.status).toBe(200)
	expect(saved.body).toMatchObject({ category_id: id(1), revision: start + 1 })
	const stored = await db()
		.collection('categories')
		.findOne({ _id: new mongo.ObjectId(id(1)) })
	expect(stored).toMatchObject({
		google_product_category: { id: 500000, path: 'Hardware > Power' }
	})
	expect(stored).not.toHaveProperty('export_rules')
	const read = await request(server())
		.get(`/categories/${id(1)}/admin/export`)
		.set('x-test-role', 'ADMIN')
	expect(read.body).toEqual({
		category_id: id(1),
		revision: start + 1,
		name: 'АВР',
		slug: 'avr',
		kind: 'product',
		status: 'active',
		google_product_category: { id: 500000, path: 'Hardware > Power' }
	})
	expect((await save(1)).body).toMatchObject({ details: { code: 'EXPORT_UNCHANGED' } })
	// Clearing it is a change too: the feed then omits the field and warns.
	expect((await save(1, { google_product_category: null })).status).toBe(200)
})

it('refuses the removed rule fields, groups and bad taxonomy', async () => {
	// Title/highlight keys and static labels were removed (owner, 04.11.2026): strict body.
	const removed = await save(1, body({ export_rules: { title_keys: [] } }))
	expect(removed.status).toBe(400)
	expect(removed.body).toMatchObject({ details: { code: 'INVALID_EXPORT_FIELDS' } })
	expect((await save(1, body({ google_product_category: { id: -1, path: 'x' } }))).status).toBe(
		400
	)
	expect((await save(2)).body).toMatchObject({ details: { code: 'CATEGORY_EXPORT_UNAVAILABLE' } })
	expect(await db().collection('catalog_control').findOne({})).toMatchObject({ phase: 'idle' })
})
