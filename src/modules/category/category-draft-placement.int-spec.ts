import { CatalogMutationJournal } from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { CategoryTreeWriter } from './category-tree-writer'
import {
	CatalogOperationController,
	CategoryDraftPlacementController,
	CategoryDraftPlacementService
} from './category-draft-placement'
const id = (n: number) => n.toString(16).padStart(24, '0')
let app: INestApplication, gate: CatalogWriteGate
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('draft-placement-http')
	app = await createRbacApp({
		controllers: [CategoryDraftPlacementController, CatalogOperationController],
		providers: [
			CategoryDraftPlacementService,
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
	gate = new CatalogWriteGate(mongoose.connection.db!)
	await gate.initialize()
	const writer = new CategoryTreeWriter(mongoose.connection.db!)
	for (const n of [1, 2])
		await writer.create(
			{ operationId: `setup-${n}`, ownerId: 'fixture', expectedRevision: n - 1 },
			{
				id: id(n),
				parent_id: null,
				kind: 'group',
				order: 0,
				name: `Group ${n}`,
				slug: `group-${n}`,
				attribute_definitions: []
			}
		)
})
afterAll(async () => {
	await app?.close()
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
async function enable() {
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
}
function move(
	key: string = randomUUID(),
	body: object = { parent_id: id(2), order: 3, expected_revision: 2 },
	target = id(1),
	role = 'ADMIN'
) {
	const req = request(app.getHttpServer() as Server)
		.patch(`/categories/${target}/draft-placement`)
		.set('Idempotency-Key', key)
	if (role) req.set('x-test-role', role)
	return req.send(body)
}
it('is disabled by default and never bootstraps or mutates the tree via HTTP', async () => {
	const before = await gate.readStamp()
	expect((await move()).status).toBe(503)
	expect(await gate.readStamp()).toEqual(before)
	expect(await mongoose.connection.collection('catalog_operations').countDocuments()).toBe(2)
	await mongoose.connection.collection('catalog_control').deleteMany({})
	expect((await move()).status).toBe(503)
	expect(await mongoose.connection.collection('catalog_control').countDocuments()).toBe(0)
})
it('keeps authorization and input validation before writes', async () => {
	await enable()
	expect((await move(undefined, undefined, undefined, '')).status).toBe(401)
	expect((await move(undefined, undefined, undefined, 'USER')).status).toBe(403)
	expect((await move('bad-key')).status).toBe(400)
	for (const body of [
		{ parent_id: id(2), order: 0 },
		{ parent_id: 'bad', order: 0, expected_revision: 2 },
		{ order: 0, expected_revision: 2 },
		{ parent_id: null, order: -1, expected_revision: 2 }
	])
		expect((await move(undefined, body)).status).toBe(400)
	expect((await gate.readStamp()).revision).toBe(2)
})
it('moves a draft under the journal and replays its receipt without changing slug or revision again', async () => {
	await enable()
	const key = randomUUID()
	const res = await move(key)
	expect(res.status).toBe(200)
	expect(res.body).toEqual({ operation_id: key, revision: 3, category_id: id(1) })
	expect((await move(key)).body).toEqual(res.body)
	expect((await gate.readStamp()).revision).toBe(3)
	expect(
		await mongoose.connection
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id(1)) })
	).toMatchObject({ slug: 'group-1', parent_id: new mongo.ObjectId(id(2)), order: 3 })
	expect((await move(key, { parent_id: null, order: 0, expected_revision: 2 })).status).toBe(409)
})
it('rejects stale revision, cycles and missing parents while keeping the gate available', async () => {
	await enable()
	expect(
		(await move(undefined, { parent_id: null, order: 0, expected_revision: 0 })).status
	).toBe(409)
	expect(
		(await move(undefined, { parent_id: id(99), order: 0, expected_revision: 2 })).status
	).toBe(404)
	expect((await move()).status).toBe(200)
	expect(
		(await move(undefined, { parent_id: id(1), order: 0, expected_revision: 3 }, id(2))).status
	).toBe(409)
	expect((await gate.readStamp()).revision).toBe(3)
})
it('moves a published node only under a public group; a draft branch moves anywhere', async () => {
	await enable()
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: new mongo.ObjectId(id(2)) }, { $set: { status: 'active' } })
	// Group 1 is a draft: under it the published group 2 would vanish from the storefront.
	const hidden = await move(
		undefined,
		{ parent_id: id(1), order: 0, expected_revision: 2 },
		id(2)
	)
	expect(hidden.status).toBe(409)
	expect(hidden.body).toMatchObject({ details: { code: 'CATEGORY_PARENT_NOT_PUBLIC' } })
	expect((await gate.readStamp()).revision).toBe(2)
	// The draft group 1 may go under the published one; then it cannot take group 2 back (cycle).
	expect((await move()).status).toBe(200)
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: new mongo.ObjectId(id(1)) }, { $set: { status: 'archived' } })
	expect(
		(await move(undefined, { parent_id: null, order: 0, expected_revision: 3 })).body
	).toMatchObject({
		details: { code: 'CATEGORY_ARCHIVED' }
	})
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: new mongo.ObjectId(id(1)) }, { $set: { status: 'active' } })
	expect(
		(await move(undefined, { parent_id: id(1), order: 0, expected_revision: 3 }, id(2))).body
	).toMatchObject({ details: { code: 'CATEGORY_CYCLE' } })
	expect((await gate.readStamp()).revision).toBe(3)
})
it('serializes simultaneous HTTP moves under one expected revision', async () => {
	await enable()
	const results = await Promise.all([
		move(),
		move(undefined, { parent_id: id(1), order: 0, expected_revision: 2 }, id(2))
	])
	expect(results.filter(res => res.status === 200)).toHaveLength(1)
	expect(results.filter(res => [409, 503].includes(res.status))).toHaveLength(1)
	expect((await gate.readStamp()).revision).toBe(3)
})

it('returns an inspection receipt after a post-write failure and refuses a blind replay', async () => {
	await enable()
	// Captured method is invoked with its original receiver below.
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const execute = CatalogMutationJournal.prototype.execute
	const fault = jest
		.spyOn(CatalogMutationJournal.prototype, 'execute')
		.mockImplementationOnce(async function (this: CatalogMutationJournal, token, direction) {
			await execute.call(this, token, direction)
			throw Error('injected acknowledgement loss')
		})
	const key = randomUUID()
	try {
		const res = await move(key)
		expect(res.status).toBe(503)
		expect(res.body).toMatchObject({
			details: { code: 'CATALOG_OPERATION_REQUIRES_INSPECTION', operation_id: key }
		})
	} finally {
		fault.mockRestore()
	}
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
	expect((await move(key)).status).toBe(409)
	expect(
		await mongoose.connection
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id(1)) })
	).toMatchObject({ parent_id: new mongo.ObjectId(id(2)) })
})

it('exposes a sanitized operation receipt to ADMIN even after draft writes are disabled', async () => {
	await enable()
	const key = randomUUID()
	await move(key)
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: false } })
	const path = `/catalog-operations/${key}`
	const server = app.getHttpServer() as Server
	expect((await request(server).get(path)).status).toBe(401)
	expect((await request(server).get(path).set('x-test-role', 'USER')).status).toBe(403)
	const res = await request(server).get(path).set('x-test-role', 'ADMIN')
	expect(res.status).toBe(200)
	expect(res.body).toEqual({
		operation_id: key,
		status: 'completed',
		result_revision: 3,
		error_code: null
	})
	expect(
		(
			await request(server)
				.get(`/catalog-operations/${randomUUID()}`)
				.set('x-test-role', 'ADMIN')
		).status
	).toBe(404)
})
it('reports pending/recovery without exposing ownership, hashes or before-images', async () => {
	const key = randomUUID()
	const token = await gate.acquire(key, 'private-hash', 'private-owner', 2)
	const get = () =>
		request(app.getHttpServer() as Server)
			.get(`/catalog-operations/${key}`)
			.set('x-test-role', 'ADMIN')
	expect((await get()).body).toEqual({
		operation_id: key,
		status: 'pending',
		result_revision: null,
		error_code: null
	})
	await gate.requireRecovery(token)
	expect((await get()).body).toEqual({
		operation_id: key,
		status: 'recovery_required',
		result_revision: null,
		error_code: null
	})
	await expect(gate.readStamp()).rejects.toMatchObject({ code: 'CATALOG_MAINTENANCE' })
})

function createDraft(key = randomUUID(), body: object = {}) {
	return request(app.getHttpServer() as Server)
		.post('/categories/drafts')
		.set('x-test-role', 'ADMIN')
		.set('Idempotency-Key', key)
		.send({
			name: 'Електроковдри',
			slug: 'electric-blankets',
			kind: 'product',
			parent_id: id(1),
			order: 0,
			expected_revision: 2,
			...body
		})
}
// What a new product category starts with (owner, 2026-11-08): the brand, required, so its products
// can enter Google Merchant — an ordinary characteristic the admin may change or remove.
const defaultBrand = [
	{
		key: 'vyrobnyk',
		label: 'Виробник',
		value_type: 'string',
		semantic: 'brand',
		is_required: true,
		filter_enabled: true,
		filter_type: 'multi-select',
		visible_in_specs: true,
		multiple: false,
		order: 0,
		unit: null,
		options: []
	}
]
it('creates one child draft with the default brand and a stable receipt on retry', async () => {
	await enable()
	const key = randomUUID()
	const created = await createDraft(key)
	expect(created.status).toBe(201)
	expect((await createDraft(key)).body).toEqual(created.body)
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(3)
	expect(
		await mongoose.connection.collection('categories').findOne({
			_id: new mongo.ObjectId((created.body as { category_id: string }).category_id)
		})
	).toMatchObject({
		name: 'Електроковдри',
		kind: 'product',
		status: 'draft',
		attribute_contract_version: 2,
		attribute_definitions: defaultBrand,
		parent_id: new mongo.ObjectId(id(1))
	})
	expect((await createDraft(key, { name: 'Other' })).status).toBe(409)
})
it('rejects invalid, duplicate and product-parent creation without orphan rows', async () => {
	await enable()
	expect((await createDraft(undefined, { name: '   ' })).status).toBe(400)
	expect((await createDraft(undefined, { slug: '../bad' })).status).toBe(400)
	expect((await createDraft(undefined, { slug: 'group-1' })).status).toBe(409)
	const child = await createDraft()
	expect(
		(
			await createDraft(undefined, {
				name: 'Nested',
				slug: 'nested',
				parent_id: (child.body as { category_id: string }).category_id,
				expected_revision: 3
			})
		).status
	).toBe(409)
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(3)
})
it('names the category a new name or address collides with, and what collided (P01)', async () => {
	await enable()
	const group = (n: number) => ({ id: id(n), name: `Group ${n}`, slug: `group-${n}` })
	const bySlug = await createDraft(undefined, { name: 'Інша назва', slug: 'group-1' })
	expect(bySlug.status).toBe(409)
	expect((bySlug.body as { details: object }).details).toMatchObject({
		code: 'CATEGORY_IDENTITY_CONFLICT',
		conflict: { field: 'slug', category: group(1) }
	})
	const byName = await createDraft(undefined, { name: 'Group 2', slug: 'free-address' })
	expect((byName.body as { details: object }).details).toMatchObject({
		conflict: { field: 'name', category: group(2) }
	})
	const rename = await request(app.getHttpServer() as Server)
		.patch(`/categories/${id(1)}/admin/details`)
		.set('x-test-role', 'ADMIN')
		.set('Idempotency-Key', randomUUID())
		.send({ name: 'Group 2', expected_revision: 2 })
	expect(rename.status).toBe(409)
	expect((rename.body as { details: object }).details).toMatchObject({
		code: 'CATEGORY_IDENTITY_CONFLICT',
		conflict: { field: 'name', category: group(2) }
	})
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(2)
})
it('renames drafts and published categories while preserving URL, and refuses legacy ones', async () => {
	await enable()
	const key = randomUUID()
	const rename = () =>
		request(app.getHttpServer() as Server)
			.patch(`/categories/${id(1)}/admin/details`)
			.set('x-test-role', 'ADMIN')
			.set('Idempotency-Key', key)
			.send({ name: 'Електротовари', expected_revision: 2 })
	expect((await rename()).status).toBe(200)
	expect((await rename()).status).toBe(200)
	expect(
		await mongoose.connection
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id(1)) })
	).toMatchObject({ name: 'Електротовари', slug: 'group-1' })
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: new mongo.ObjectId(id(1)) }, { $set: { status: 'active' } })
	const published = await request(app.getHttpServer() as Server)
		.patch(`/categories/${id(1)}/admin/details`)
		.set('x-test-role', 'ADMIN')
		.set('Idempotency-Key', randomUUID())
		.send({ name: 'Changed', expected_revision: 3 })
	expect(published.status).toBe(200)
	expect(
		await mongoose.connection
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id(1)) })
	).toMatchObject({ name: 'Changed', slug: 'group-1', status: 'active' })
	// A flat legacy (v1) category is the old admin's, even while that admin is closed.
	await mongoose.connection
		.collection('categories')
		.insertOne({ _id: new mongo.ObjectId(id(3)), name: 'Legacy', slug: 'legacy' })
	const legacy = await request(app.getHttpServer() as Server)
		.patch(`/categories/${id(3)}/admin/details`)
		.set('x-test-role', 'ADMIN')
		.set('Idempotency-Key', randomUUID())
		.send({ name: 'Legacy 2', expected_revision: 4 })
	expect(legacy.status).toBe(409)
	expect(legacy.body).toMatchObject({
		details: { code: 'CATALOG_CONTRACT_UPGRADE_REQUIRED' }
	})
	expect((await gate.readStamp()).revision).toBe(4)
})
it('reports rollout capabilities without initializing a catalog or leaking control data', async () => {
	const get = () =>
		request(app.getHttpServer() as Server)
			.get('/categories/admin/capabilities')
			.set('x-test-role', 'ADMIN')
	expect((await get()).body).toEqual({
		draft_writes_enabled: false,
		legacy_writes_enabled: false
	})
	await enable()
	expect((await get()).body).toEqual({ draft_writes_enabled: true, legacy_writes_enabled: false })
	await gate.acquire('busy', 'hash', 'owner', 2)
	expect(((await get()).body as { draft_writes_enabled: boolean }).draft_writes_enabled).toBe(
		false
	)
	await mongoose.connection.collection('catalog_control').deleteMany({})
	expect((await get()).body).toEqual({ draft_writes_enabled: false, legacy_writes_enabled: true })
})
it('requires ADMIN for new endpoints and rejects writes while rollout is disabled', async () => {
	const server = app.getHttpServer() as Server
	for (const path of ['/categories/drafts', `/categories/${id(1)}/admin/details`]) {
		const call = (role?: string) => {
			const req = path.endsWith('/drafts')
				? request(server).post(path)
				: request(server).patch(path)
			return role ? req.set('x-test-role', role) : req
		}
		expect((await call().send({})).status).toBe(401)
		expect((await call('USER').send({})).status).toBe(403)
	}
	expect((await request(server).get('/categories/admin/capabilities')).status).toBe(401)
	expect(
		(await request(server).get('/categories/admin/capabilities').set('x-test-role', 'USER'))
			.status
	).toBe(403)
	expect((await createDraft()).status).toBe(503)
	expect(await mongoose.connection.collection('categories').countDocuments()).toBe(2)
})

const numericDefinition = {
	label: 'Номінальний струм',
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
function definitions(
	target: string,
	revision: number,
	values: object[],
	key = randomUUID(),
	role = 'ADMIN'
) {
	const req = request(app.getHttpServer() as Server)
		.patch(`/categories/${target}/admin/definitions`)
		.set('Idempotency-Key', key)
	if (role) req.set('x-test-role', role)
	return req.send({ expected_revision: revision, definitions: values })
}
const configuration = (target: string, role = 'ADMIN') => {
	const req = request(app.getHttpServer() as Server).get(
		`/categories/${target}/admin/configuration`
	)
	return role ? req.set('x-test-role', role) : req
}
it('saves typed definitions, exposes derived controls, and replays without new keys', async () => {
	await enable()
	const created = (await createDraft()).body as { category_id: string }
	const key = randomUUID()
	const saved = await definitions(created.category_id, 3, [numericDefinition], key)
	expect(saved.status).toBe(200)
	expect((await definitions(created.category_id, 3, [numericDefinition], key)).body).toEqual(
		saved.body
	)
	const config = await configuration(created.category_id)
	expect(config.status).toBe(200)
	expect(config.headers['cache-control']).toBe('no-store')
	const body = config.body as {
		revision: number
		definitions: { key: string; label: string }[]
		controls: { filters: object[]; fields: object[] }
	}
	expect(body.revision).toBe(4)
	expect(body.definitions[0].key).toMatch(/^a_[a-f0-9]{32}$/)
	expect(body.controls.filters).toEqual(body.definitions)
	expect(
		(
			await definitions(created.category_id, 4, [
				{ ...numericDefinition, key: body.definitions[0].key, label: 'Струм навантаження' }
			])
		).status
	).toBe(200)
	expect((await configuration(created.category_id)).body).toMatchObject({
		definitions: [{ key: body.definitions[0].key, label: 'Струм навантаження' }]
	})
})
it('validates authorization, typed payloads, foreign keys and category kind before any domain writes', async () => {
	await enable()
	const created = (await createDraft()).body as { category_id: string }
	expect((await definitions(created.category_id, 3, [], undefined, '')).status).toBe(401)
	expect((await definitions(created.category_id, 3, [], undefined, 'USER')).status).toBe(403)
	expect((await configuration(created.category_id, '')).status).toBe(401)
	expect((await configuration(created.category_id, 'USER')).status).toBe(403)
	for (const patch of [
		{ value_type: 'bad' },
		{ filter_enabled: false },
		{ multiple: true },
		{ key: 'foreign' },
		{ label: ' ' },
		{ options: [{ id: null, label: 'x', order: 0 }] }
	])
		expect(
			(await definitions(created.category_id, 3, [{ ...numericDefinition, ...patch }])).status
		).toBe(400)
	expect((await definitions(id(1), 3, [numericDefinition])).status).toBe(409)
	expect((await gate.readStamp()).revision).toBe(3)
})
it('protects keys products hold and does not mutate definitions when the revision or rollout state changed', async () => {
	await enable()
	const created = (await createDraft()).body as { category_id: string }
	await definitions(created.category_id, 3, [numericDefinition])
	const config = (await configuration(created.category_id)).body as {
		definitions: { key: string }[]
	}
	// A landing without typed pins does not lock anything; a product holding the key does.
	await mongoose.connection
		.collection('landings')
		.insertOne({ category_id: new mongo.ObjectId(created.category_id), status: 'draft' })
	await mongoose.connection.collection('products').insertOne({
		category_id: new mongo.ObjectId(created.category_id),
		variant_axis: null,
		attributes_v2: [{ k: config.definitions[0].key, v: 16 }]
	})
	const removal = await definitions(created.category_id, 4, [])
	expect(removal.status).toBe(409)
	expect(removal.body).toMatchObject({
		details: {
			code: 'DEFINITION_IN_USE',
			key: config.definitions[0].key,
			usage: { products: 1, variants: 0, landings: 0 }
		}
	})
	// The unit of a held value is part of it (owner decision 31.10.2026): refused, nothing written.
	const unit = await definitions(created.category_id, 4, [
		{ ...config.definitions[0], unit: 'мА' }
	])
	expect(unit.status).toBe(409)
	expect(unit.body).toMatchObject({
		details: {
			code: 'DEFINITION_UNIT_LOCKED',
			key: config.definitions[0].key,
			usage: { products: 1, variants: 0, landings: 0 }
		}
	})
	expect(
		(await definitions(created.category_id, 4, [{ ...config.definitions[0], label: 'Струм' }]))
			.status
	).toBe(200)
	expect((await definitions(created.category_id, 4, config.definitions)).status).toBe(409)
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: false } })
	expect((await definitions(created.category_id, 5, config.definitions)).status).toBe(503)
	expect((await configuration(created.category_id)).status).toBe(200)
})
it('fails configuration reads closed across catalog changes and refuses archived category edits', async () => {
	await enable()
	const created = (await createDraft()).body as { category_id: string }
	await mongoose.connection
		.collection('categories')
		.updateOne(
			{ _id: new mongo.ObjectId(created.category_id) },
			{ $set: { status: 'archived' } }
		)
	const archived = await definitions(created.category_id, 3, [])
	expect(archived.status).toBe(409)
	expect(archived.body).toMatchObject({ details: { code: 'CATEGORY_ARCHIVED' } })
	const fault = jest
		.spyOn(CatalogWriteGate.prototype, 'assertReadUnchanged')
		.mockRejectedValueOnce(Error('changed'))
	try {
		expect((await configuration(created.category_id)).status).toBe(503)
	} finally {
		fault.mockRestore()
	}
	await gate.acquire('held-for-test', 'hash', 'owner', 3)
	expect((await configuration(created.category_id)).status).toBe(503)
})

it('previews actual typed SKU values with range/false filters and self-excluding facets without writes', async () => {
	await enable()
	const created = (await createDraft()).body as { category_id: string }
	await definitions(created.category_id, 3, [
		numericDefinition,
		{
			...numericDefinition,
			label: 'Нагрів',
			value_type: 'boolean',
			unit: null,
			filter_type: 'multi-select'
		}
	])
	const config = (await configuration(created.category_id)).body as {
		definitions: { key: string }[]
	}
	const [amps, heated] = config.definitions.map(value => value.key)
	const category_id = new mongo.ObjectId(created.category_id),
		product_id = new mongo.ObjectId()
	await mongoose.connection.collection('products').insertOne({
		_id: product_id,
		category_id,
		variant_axis: { key: amps },
		attributes_v2: [{ k: heated, v: false }]
	})
	await mongoose.connection.collection('product_variants').insertMany(
		[16, 32, 63].map(variant_value => ({
			product_id,
			category_id,
			variant_value,
			status: 'draft'
		}))
	)
	const preview = (attributes: object[], role = 'ADMIN') => {
		const req = request(app.getHttpServer() as Server).post(
			`/categories/${created.category_id}/admin/filter-preview`
		)
		return (role ? req.set('x-test-role', role) : req).send({ attributes })
	}
	expect((await preview([], '')).status).toBe(401)
	expect((await preview([], 'USER')).status).toBe(403)
	const result = await preview([
		{ key: amps, min: 20, max: 40 },
		{ key: heated, values: [false] }
	])
	expect(result.status).toBe(200)
	expect(result.body).toMatchObject({
		revision: 4,
		total_variants: 1,
		total_products: 1
	})
	expect((result.body as { facets: unknown[] }).facets).toContainEqual({
		key: amps,
		values: [],
		min: 16,
		max: 63
	})
	expect((await preview([{ key: heated, values: ['false'] }])).status).toBe(400)
	expect((await gate.readStamp()).revision).toBe(4)
	await mongoose.connection
		.collection('products')
		.updateOne({ _id: product_id }, { $unset: { attributes_v2: '' } })
	expect((await preview([])).status).toBe(503)
})

describe('deleting and converting drafts over HTTP (Plan-0010 B02)', () => {
	const post = (path: string, body: object, key = randomUUID(), role = 'ADMIN') => {
		const req = request(app.getHttpServer() as Server)
			.post(`/categories/${path}`)
			.set('Idempotency-Key', key)
		if (role) req.set('x-test-role', role)
		return req.send(body)
	}
	const category = (n: number) =>
		mongoose.connection.collection('categories').findOne({ _id: new mongo.ObjectId(id(n)) })

	it('deletes an empty draft with a replayable receipt, and refuses a draft in use', async () => {
		await enable()
		expect(
			(await post(`${id(1)}/admin/deletion`, { expected_revision: 2 }, undefined, 'USER'))
				.status
		).toBe(403)
		// Group 2 under group 1 → group 1 has a child and is refused.
		const moved = await move(
			randomUUID(),
			{ parent_id: id(1), order: 0, expected_revision: 2 },
			id(2)
		)
		expect(moved.status).toBe(200)
		const inUse = await post(`${id(1)}/admin/deletion`, { expected_revision: 3 })
		expect(inUse.status).toBe(409)
		expect(inUse.body).toMatchObject({ details: { code: 'CATEGORY_IN_USE' } })
		const key = randomUUID()
		const deleted = await post(`${id(2)}/admin/deletion`, { expected_revision: 3 }, key)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toMatchObject({ category_id: id(2), revision: 4 })
		expect(await category(2)).toBeNull()
		expect((await post(`${id(2)}/admin/deletion`, { expected_revision: 3 }, key)).body).toEqual(
			deleted.body
		)
		expect((await post(`${id(99)}/admin/deletion`, { expected_revision: 4 })).status).toBe(404)
		// A published category is never deleted this way.
		await mongoose.connection
			.collection('categories')
			.updateOne({ _id: new mongo.ObjectId(id(1)) }, { $set: { status: 'active' } })
		const active = await post(`${id(1)}/admin/deletion`, { expected_revision: 4 })
		expect(active.body).toMatchObject({ details: { code: 'CATEGORY_DELETE_REQUIRES_DRAFT' } })
		expect(await gate.readStamp()).toMatchObject({ revision: 4 })
		expect(await mongoose.connection.collection('catalog_control').findOne({})).toMatchObject({
			phase: 'idle'
		})
	})

	it('converts an empty draft group ↔ product and refuses one with products', async () => {
		await enable()
		const converted = await post(`${id(1)}/admin/conversion`, {
			kind: 'product',
			expected_revision: 2
		})
		expect(converted.status).toBe(200)
		expect(await category(1)).toMatchObject({
			kind: 'product',
			attribute_definitions: defaultBrand
		})
		expect(
			(await post(`${id(1)}/admin/conversion`, { kind: 'product', expected_revision: 3 }))
				.body
		).toMatchObject({ details: { code: 'CATEGORY_KIND_UNCHANGED' } })
		expect(
			(await post(`${id(1)}/admin/conversion`, { kind: 'shelf', expected_revision: 3 }))
				.status
		).toBe(400)
		await mongoose.connection
			.collection('products')
			.insertOne({ name: 'Ковдра', category_id: new mongo.ObjectId(id(1)) })
		const populated = await post(`${id(1)}/admin/conversion`, {
			kind: 'group',
			expected_revision: 3
		})
		expect(populated.status).toBe(409)
		expect(populated.body).toMatchObject({ details: { code: 'CATEGORY_IN_USE' } })
		expect(await category(1)).toMatchObject({ kind: 'product' })
		await mongoose.connection.collection('products').deleteMany({})
		expect(
			(await post(`${id(1)}/admin/conversion`, { kind: 'group', expected_revision: 3 }))
				.status
		).toBe(200)
		expect(await category(1)).toMatchObject({ kind: 'group', attribute_definitions: [] })
	})
})
