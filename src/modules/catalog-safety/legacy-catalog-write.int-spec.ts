import mongoose from 'mongoose'
import { INestApplication, RequestMethod } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { createRbacApp, send, HttpMethod } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { CategoryController } from '../category/category.controller'
import { CategoryService } from '../category/category.service'
import { ProductController } from '../product/product.controller'
import { ProductService } from '../product/product.service'
import { PriceListService } from '../product/price-list/price-list.service'
import { ColorController } from '../color/color.controller'
import { ColorService } from '../color/color.service'
import { LandingController } from '../landing/landing.controller'
import { LandingService } from '../landing/landing.service'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from './legacy-catalog-write.interceptor'
const controllers = [CategoryController, ProductController, ColorController, LandingController]
const services = [CategoryService, ProductService, ColorService, LandingService]
const calls = jest.fn().mockResolvedValue({ ok: true })
const pdf = jest.fn().mockResolvedValue({ buffer: Buffer.from('test'), filename: 'test.pdf' })
let app: INestApplication
let policy: LegacyCatalogWritePolicy
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('legacy-catalog-interlock')
	app = await createRbacApp({
		controllers,
		providers: [
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor },
			...services.map((service, index) => ({
				provide: service,
				useValue: Object.fromEntries(
					Object.getOwnPropertyNames(controllers[index].prototype)
						.filter(name => name !== 'constructor')
						.map(name => [name, calls])
				)
			})),
			{
				provide: PriceListService,
				useValue: {
					generatePdf: pdf
				}
			}
		]
	})
	policy = app.get(LegacyCatalogWritePolicy)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	calls.mockReset().mockResolvedValue({ ok: true })
	pdf.mockReset().mockResolvedValue({ buffer: Buffer.from('test'), filename: 'test.pdf' })
})
afterAll(async () => {
	await app?.close()
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
async function control(phase = 'idle') {
	await mongoose.connection
		.db!.collection<{ _id: string }>('catalog_control')
		.insertOne({ _id: 'catalog', phase, revision: 0, epoch: 0 } as never)
}
it('retains old writes before bootstrap, including additive v1 staging', async () => {
	await mongoose.connection.collection('categories').insertMany([
		{ name: 'Legacy' },
		{
			name: 'Staged',
			parent_id: null,
			kind: 'product',
			status: 'active',
			attribute_contract_version: 1,
			attribute_definitions: []
		}
	])
	expect((await send(app, 'post', '/categories', { role: Role.ADMIN, body: {} })).status).toBe(
		201
	)
	expect(calls).toHaveBeenCalledTimes(1)
})
it.each(['idle', 'writing', 'published', 'recovering', 'recovery_required', 'corrupt'])(
	'blocks control phase %s without mutating it',
	async phase => {
		await control(phase)
		const before = await mongoose.connection.collection('catalog_control').findOne({})
		const response = await send(app, 'post', '/categories', { role: Role.ADMIN, body: {} })
		expect(response.status).toBe(503)
		expect(response.body).toMatchObject({ details: { code: 'CATALOG_LEGACY_WRITES_DISABLED' } })
		expect(calls).not.toHaveBeenCalled()
		expect(await mongoose.connection.collection('catalog_control').findOne({})).toEqual(before)
	}
)
it.each([
	{ attribute_contract_version: 2 },
	{ attribute_contract_version: null },
	{ kind: 'group' },
	{ parent_id: new mongoose.Types.ObjectId() },
	{ status: 'draft' }
])('rejects incompatible data without control: %j', async row => {
	await mongoose.connection.collection('categories').insertOne(row)
	await expect(policy.assertAllowed()).rejects.toMatchObject({
		status: 503,
		response: { details: { code: 'CATALOG_CONTROL_MISSING' } }
	})
})
it('covers every mutation on the four marked controllers', async () => {
	await control()
	let checked = 0
	for (const controller of controllers) {
		const base = Reflect.getMetadata(PATH_METADATA, controller) as string
		for (const name of Object.getOwnPropertyNames(controller.prototype)) {
			if (['constructor', 'validate', 'generatePriceListPdf'].includes(name)) continue
			const handler: unknown = Object.getOwnPropertyDescriptor(
				controller.prototype,
				name
			)?.value
			if (typeof handler !== 'function') continue
			const method = Reflect.getMetadata(METHOD_METADATA, handler) as
				| RequestMethod
				| undefined
			if (
				method === undefined ||
				![
					RequestMethod.POST,
					RequestMethod.PUT,
					RequestMethod.PATCH,
					RequestMethod.DELETE
				].includes(method)
			)
				continue
			const path = Reflect.getMetadata(PATH_METADATA, handler) as string
			const url = `/${base}/${path}`
				.replace(/\/+/g, '/')
				.replace(/:[^/]+/g, '000000000000000000000001')
			const response = await send(
				app,
				RequestMethod[method].toLowerCase() as HttpMethod,
				url,
				{ role: Role.ADMIN, body: {} }
			)
			expect({ url, status: response.status }).toEqual({ url, status: 503 })
			checked++
		}
	}
	expect(checked).toBeGreaterThanOrEqual(18)
	expect(calls).not.toHaveBeenCalled()
})
it('keeps auth before the interlock and GET/read-only POST available', async () => {
	await control()
	expect((await send(app, 'post', '/categories')).status).toBe(401)
	expect((await send(app, 'post', '/categories', { role: Role.USER })).status).toBe(403)
	expect(calls).not.toHaveBeenCalled()
	expect((await send(app, 'get', '/categories')).status).toBe(200)
	expect(
		(await send(app, 'post', '/products/validate', { role: Role.ADMIN, body: {} })).status
	).toBe(201)
})

it('keeps the PDF POST read-only after bootstrap', async () => {
	await control()
	const response = await send(app, 'post', '/products/price-list/pdf', {
		role: Role.ADMIN,
		body: {}
	})
	expect(response.status).toBe(201)
	expect(response.headers['content-type']).toContain('application/pdf')
})

it.each(['writing', 'published', 'recovering', 'recovery_required'])(
	'blocks reads before services in phase %s',
	async phase => {
		await control(phase)
		const response = await send(app, 'get', '/categories')
		expect(response.status).toBe(503)
		expect(response.body).toMatchObject({ details: { code: 'CATALOG_MAINTENANCE' } })
		expect(response.headers['retry-after']).toBe('5')
		expect(response.headers['cache-control']).toBe('no-store')
		expect(calls).not.toHaveBeenCalled()
	}
)
it.each(['epoch', 'revision', 'bootstrap', 'removed-control'])(
	'discards a response on %s change during a read',
	async change => {
		if (change !== 'bootstrap') await control()
		calls.mockImplementationOnce(async () => {
			if (change === 'bootstrap') await control()
			else if (change === 'removed-control')
				await mongoose.connection.collection('catalog_control').deleteMany({})
			else
				await mongoose.connection
					.collection('catalog_control')
					.updateOne({}, { $inc: { [change]: 1 } })
			return { sensitive_partial_result: true }
		})
		const response = await send(app, 'get', '/categories')
		expect(response.status).toBe(503)
		expect(response.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
		expect(JSON.stringify(response.body)).not.toContain('sensitive_partial_result')
		expect(response.headers['cache-control']).toBe('no-store')
	}
)
describe('one read barrier per request (audit 11.11)', () => {
	let reads = 0
	let spy: jest.SpyInstance
	beforeEach(() => {
		reads = 0
		const { prototype } = mongoose.mongo.Collection
		const findOne = Reflect.get(prototype, 'findOne') as (...args: unknown[]) => unknown
		spy = jest.spyOn(prototype, 'findOne').mockImplementation(function (
			this: { collectionName: string },
			...args: unknown[]
		) {
			if (this.collectionName === 'catalog_control') reads++
			return findOne.apply(this, args) as never
		} as never)
	})
	afterEach(() => spy.mockRestore())

	it('reuses the request stamp in nested reads, re-reads only for a stricter one', async () => {
		await control()
		let nested: unknown
		calls.mockImplementationOnce(async () => {
			const stamp = await policy.beginRead(true)
			nested = stamp
			await policy.finishRead(stamp, true)
			// Stricter than this adapted read: a barrier of its own.
			const strict = await policy.beginRead()
			await policy.finishRead(strict)
			return { ok: true }
		})
		const response = await send(app, 'get', '/categories')
		expect(response.status).toBe(200)
		expect(nested).toEqual({ initialized: true, revision: 0, epoch: 0 })
		// The request's begin and end, and the stricter pair — not the adapted nested pair.
		expect(reads).toBe(4)
	})

	it('still discards a response when a write lands between nested reads', async () => {
		await control()
		calls.mockImplementationOnce(async () => {
			const stamp = await policy.beginRead(true)
			await mongoose.connection
				.collection('catalog_control')
				.updateOne({}, { $inc: { epoch: 1 } })
			await policy.finishRead(stamp, true)
			return { sensitive_partial_result: true }
		})
		const response = await send(app, 'get', '/categories')
		expect(response.status).toBe(503)
		expect(response.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
		expect(JSON.stringify(response.body)).not.toContain('sensitive_partial_result')
	})

	it('closes with the request: work outliving it verifies on its own', async () => {
		await control()
		let release!: () => void
		const gate = new Promise<void>(resolve => (release = resolve))
		let later!: Promise<void>
		calls.mockImplementationOnce(async () => {
			const stamp = await policy.beginRead(true)
			later = gate.then(() => policy.finishRead(stamp, true))
			later.catch(() => undefined)
			return { ok: true }
		})
		expect((await send(app, 'get', '/categories')).status).toBe(200)
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { epoch: 1 } })
		release()
		await expect(later).rejects.toMatchObject({
			response: { details: { code: 'CATALOG_READ_CHANGED' } }
		})
	})
})
it('refuses legacy projections of v2 even when control is idle', async () => {
	await control()
	await mongoose.connection
		.collection('categories')
		.insertOne({ attribute_contract_version: 2, status: 'draft' })
	// The variant slug list is still an unadapted legacy projection; the catalogue, search, price
	// sheet, product page, landings and colours have visibility adapters.
	const response = await send(app, 'get', '/products/variants/slugs')
	expect(response.status).toBe(503)
	expect(response.body).toMatchObject({ details: { code: 'CATALOG_READ_UPGRADE_REQUIRED' } })
	expect(calls).not.toHaveBeenCalled()
})
it('discards a prepared PDF before any bytes or PDF headers are sent', async () => {
	await control()
	pdf.mockImplementationOnce(async () => {
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { epoch: 1 } })
		return { buffer: Buffer.from('partial-secret-pdf'), filename: 'partial.pdf' }
	})
	const response = await send(app, 'post', '/products/price-list/pdf', {
		role: Role.ADMIN,
		body: {}
	})
	expect(response.status).toBe(503)
	expect(response.headers['content-type']).toContain('application/json')
	expect(response.headers['content-disposition']).toBeUndefined()
	expect(response.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
	expect(JSON.stringify(response.body)).not.toContain('partial-secret-pdf')
})
it('fails closed on malformed idle counters', async () => {
	await control()
	await mongoose.connection.collection('catalog_control').updateOne({}, { $set: { epoch: -1 } })
	await expect(policy.beginRead()).rejects.toMatchObject({ status: 503 })
})
