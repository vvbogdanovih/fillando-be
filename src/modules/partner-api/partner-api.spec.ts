import type { Server } from 'node:http'
import { PartnerApiToken } from 'src/database/mongoose/schemas/partner-api-token.schema'
import { getModelToken } from '@nestjs/mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Module } from '@nestjs/common'
import { Types } from 'mongoose'
import request from 'supertest'
import { ThrottlerModule } from '@nestjs/throttler'
import { Test } from '@nestjs/testing'
import { PartnerApiRepository } from 'src/database/mongoose/repositories/partner-api.repository'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { PartnerApiService, hashPartnerToken } from './partner-api.service'
import { PartnerApiController } from './partner-api.controller'
import { PartnerTokenController } from './partner-token.controller'
import { PartnerApiModule } from './partner-api.module'
import { createPartnerDocument } from './partner-api.swagger'

const id = new Types.ObjectId()
const raw = 'flnd_live_' + 'a'.repeat(64)
const second = 'flnd_live_' + 'b'.repeat(64)
const repository = {
	authenticate: jest.fn(),
	touch: jest.fn().mockResolvedValue({}),
	availability: jest.fn(),
	bulkAvailability: jest.fn(),
	create: jest.fn<Promise<unknown>, [Partial<PartnerApiToken>]>(),
	list: jest.fn(),
	revoke: jest.fn()
}
@Module({
	controllers: [PartnerApiController],
	providers: [PartnerApiService, { provide: PartnerApiRepository, useValue: repository }]
})
class PublicTestModule {}

describe('Partner API HTTP contract', () => {
	let app: INestApplication
	beforeEach(async () => {
		jest.clearAllMocks()
		repository.authenticate.mockImplementation((hash: string) =>
			Promise.resolve(
				hash === hashPartnerToken(raw)
					? { _id: id }
					: hash === hashPartnerToken(second)
						? { _id: new Types.ObjectId('000000000000000000000002') }
						: null
			)
		)
		repository.availability.mockResolvedValue({
			sku: 'FL-000123',
			stock: 12,
			stock_updated_at: new Date('2026-09-12T00:00:00Z'),
			prom_id: 'never expose',
			price: 500
		})
		const mod = await Test.createTestingModule({
			imports: [
				PartnerApiModule,
				ThrottlerModule.forRoot({
					throttlers: [{ ttl: 60000, limit: 20 }],
					skipIf: () => true
				})
			]
		})
			.overrideModule(PartnerApiModule)
			.useModule(PublicTestModule)
			.compile()
		app = mod.createNestApplication({ logger: false })
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
		await app.listen(0, '127.0.0.1')
	})
	afterEach(async () => app.close())
	const get = (app: INestApplication, token = raw) =>
		request(app.getHttpServer() as Server)
			.get('/partner/v1/products/FL-000123/availability')
			.set('Authorization', 'Bearer ' + token)
	const bulk = (body: unknown, token = raw) =>
		request(app.getHttpServer() as Server)
			.post('/partner/v1/products/availability')
			.set('Authorization', 'Bearer ' + token)
			.send(body as object)
	it('returns ordered unique items and not_found with one database query', async () => {
		repository.bulkAvailability.mockResolvedValue([
			{ sku: 'B', stock: 0, stock_updated_at: null, prom_id: 'secret' },
			{ sku: 'A', stock: 12, stock_updated_at: new Date('2026-09-12T00:00:00Z'), price: 500 }
		])
		const res = await bulk({ skus: ['missing', 'A', 'B', 'A', 'missing'] })
		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			items: [
				{
					sku: 'A',
					in_stock: true,
					quantity: 12,
					stock_updated_at: '2026-09-12T00:00:00.000Z'
				},
				{ sku: 'B', in_stock: false, quantity: 0, stock_updated_at: null }
			],
			not_found: ['missing']
		})
		expect(res.headers['cache-control']).toBe('no-store')
		expect(repository.bulkAvailability).toHaveBeenCalledTimes(1)
		expect(repository.bulkAvailability).toHaveBeenCalledWith(['missing', 'A', 'B'])
		expect(repository.availability).not.toHaveBeenCalled()
	})
	it('accepts exactly 100 SKUs and returns 200 when none are found', async () => {
		const skus = Array.from({ length: 100 }, (_, i) => 'FL-' + i)
		repository.bulkAvailability.mockResolvedValue([])
		const res = await bulk({ skus })
		expect(res.status).toBe(200)
		expect(res.body).toEqual({ items: [], not_found: skus })
	})
	it.each([
		{},
		{ skus: [] },
		{ skus: null },
		{ skus: 'A' },
		{ skus: [1] },
		{ skus: [null] },
		{ skus: [{ $ne: null }] },
		{ skus: [['A']] },
		{ skus: [''] },
		{ skus: ['A'.repeat(101)] },
		{ skus: Array.from({ length: 101 }, () => 'A') }
	])('rejects invalid bulk body %j before reading products', async body => {
		expect((await bulk(body)).status).toBe(400)
		expect(repository.bulkAvailability).not.toHaveBeenCalled()
	})
	it('protects bulk reads with the same token authentication', async () => {
		expect(
			(
				await request(app.getHttpServer() as Server)
					.post('/partner/v1/products/availability')
					.send({ skus: ['A'] })
			).status
		).toBe(401)
		expect((await bulk({ skus: ['A'] }, 'bad')).status).toBe(401)
		repository.authenticate.mockResolvedValue(null)
		expect((await bulk({ skus: ['A'] })).status).toBe(401)
		expect(repository.bulkAvailability).not.toHaveBeenCalled()
	})
	it('shares the token quota between single and bulk reads', async () => {
		repository.bulkAvailability.mockResolvedValue([])
		for (let i = 0; i < 30; i++) {
			expect((await get(app)).status).toBe(200)
			expect((await bulk({ skus: ['A'] })).status).toBe(200)
		}
		const res = await bulk({ skus: ['A'] })
		expect(res.status).toBe(429)
		expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
		expect((await get(app)).status).toBe(429)
		expect((await bulk({ skus: ['A'] }, second)).status).toBe(200)
	})
	it('shares the IP quota for unauthenticated requests across endpoints', async () => {
		for (let i = 0; i < 150; i++) {
			expect((await get(app, 'bad')).status).toBe(401)
			expect((await bulk({ skus: ['A'] }, 'bad')).status).toBe(401)
		}
		const res = await bulk({ skus: ['A'] }, 'bad')
		expect(res.status).toBe(429)
		expect(res.headers['retry-after']).toBeDefined()
	})
	it('returns only the documented stock fields and disables caching', async () => {
		const res = await get(app)
		expect(res.status).toBe(200)
		expect(res.body).toEqual({
			sku: 'FL-000123',
			in_stock: true,
			quantity: 12,
			stock_updated_at: '2026-09-12T00:00:00.000Z'
		})
		expect(res.headers['cache-control']).toBe('no-store')
		expect(res.headers['x-ratelimit-limit']).toBe('60')
	})
	it('rejects missing, malformed and revoked tokens before querying stock', async () => {
		expect(
			(
				await request(app.getHttpServer() as Server).get(
					'/partner/v1/products/FL-000123/availability'
				)
			).status
		).toBe(401)
		expect((await get(app, 'bad')).status).toBe(401)
		repository.authenticate.mockResolvedValue(null)
		expect((await get(app)).status).toBe(401)
		expect(repository.availability).not.toHaveBeenCalled()
	})
	it('returns 404 for an unknown or inactive SKU', async () => {
		repository.availability.mockResolvedValue(null)
		expect((await get(app)).status).toBe(404)
	})
	it('validates the SKU length', async () => {
		expect(
			(
				await request(app.getHttpServer() as Server)
					.get('/partner/v1/products/' + 'a'.repeat(101) + '/availability')
					.set('Authorization', 'Bearer ' + raw)
			).status
		).toBe(400)
	})
	it('limits each token independently even when the internal bypass would return true', async () => {
		for (let i = 0; i < 60; i++) expect((await get(app)).status).toBe(200)
		const blocked = await get(app)
		expect(blocked.status).toBe(429)
		expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
		expect((await get(app, second)).status).toBe(200)
	})
	it('limits unauthenticated attempts by IP', async () => {
		for (let i = 0; i < 300; i++) expect((await get(app, 'bad')).status).toBe(401)
		const blocked = await get(app, 'bad')
		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
	})
})

describe('Partner token administration', () => {
	let app: INestApplication
	const service = {
		list: jest.fn().mockResolvedValue([]),
		create: jest.fn().mockResolvedValue({}),
		revoke: jest.fn().mockResolvedValue(undefined)
	}
	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [PartnerTokenController],
			providers: [{ provide: PartnerApiService, useValue: service }]
		})
	})
	afterAll(async () => app.close())
	it.each(['get', 'post', 'delete'] as const)('%s is admin-only', async method => {
		const url = '/admin/api-tokens' + (method === 'delete' ? '/' + id.toString() : '')
		expect((await send(app, method, url, { body: { name: 'CRM' } })).status).toBe(401)
		expect((await send(app, method, url, { role: 'USER', body: { name: 'CRM' } })).status).toBe(
			403
		)
		expect(
			(await send(app, method, url, { role: 'ADMIN', body: { name: 'CRM' } })).status
		).toBe(method === 'post' ? 201 : method === 'delete' ? 204 : 200)
	})
})

describe('Partner service', () => {
	const service = new PartnerApiService(repository as unknown as PartnerApiRepository)
	it('stores only the hash and never includes hash or creator in metadata', async () => {
		repository.create.mockImplementation(data =>
			Promise.resolve({
				...data,
				_id: id,
				createdAt: new Date(),
				revoked_at: null,
				last_used_at: null
			})
		)
		const result = await service.create('CRM', id.toString())
		expect(result.token).toMatch(/^flnd_live_[a-f0-9]{64}$/)
		expect(repository.create.mock.calls[0][0].token_hash).toBe(hashPartnerToken(result.token))
		expect(repository.create.mock.calls[0][0]).not.toHaveProperty('token')
		expect(result).not.toHaveProperty('token_hash')
		expect(result).not.toHaveProperty('created_by')
	})
	it.each([0, -1, NaN])('maps unavailable stock %s to zero', async stock => {
		repository.availability.mockResolvedValue({ sku: 'X', stock, stock_updated_at: null })
		expect(await service.availability('X')).toEqual({
			sku: 'X',
			in_stock: false,
			quantity: 0,
			stock_updated_at: null
		})
	})
	it('validates revocation IDs', async () => {
		await expect(service.revoke('bad')).rejects.toMatchObject({ status: 400 })
	})
})

describe('Public Swagger isolation', () => {
	it('publishes only partner endpoints with bearer security', async () => {
		const mod = await Test.createTestingModule({
			imports: [PartnerApiModule, ThrottlerModule.forRoot([{ ttl: 60000, limit: 20 }])],
			controllers: [PartnerTokenController]
		})
			.overrideProvider(getModelToken('Category'))
			.useValue({})
			.overrideProvider(getModelToken('PartnerApiToken'))
			.useValue({})
			.overrideProvider(getModelToken('ProductVariant'))
			.useValue({})
			.compile()
		const app = mod.createNestApplication({ logger: false })
		try {
			const doc = createPartnerDocument(app)
			expect(doc.paths['/partner/v1/products/skus'].get).toBeUndefined()
			expect(doc.paths['/partner/v1/categories'].get).toBeUndefined()
			expect(doc.paths['/partner/v1/categories'].post?.requestBody).toBeDefined()
			expect(doc.paths['/partner/v1/categories'].post?.responses).toHaveProperty('200')
			const postSkus = doc.paths['/partner/v1/products/skus'].post
			expect(postSkus?.security).toEqual([{ 'partner-token': [] }])
			expect(postSkus?.requestBody).toBeDefined()
			expect(postSkus?.parameters).toEqual([])
			expect(postSkus?.responses).toHaveProperty('200')
			expect(Object.keys(doc.paths).sort()).toEqual(
				[
					'/partner/v1/products/availability',
					'/partner/v1/categories',
					'/partner/v1/products/skus',
					'/partner/v1/products/lookup',
					'/partner/v1/products/{sku}/availability'
				].sort()
			)
			expect(doc.paths['/partner/v1/products/availability'].post?.security).toEqual([
				{ 'partner-token': [] }
			])
			expect(doc.paths['/partner/v1/products/availability'].post?.responses).toHaveProperty(
				'200'
			)
			expect(
				doc.paths['/partner/v1/products/availability'].post?.responses
			).not.toHaveProperty('201')
			expect(doc.paths['/partner/v1/products/{sku}/availability'].get?.security).toEqual([
				{ 'partner-token': [] }
			])
			expect(doc.components?.schemas).not.toHaveProperty('CreatedPartnerTokenDto')
		} finally {
			await app.close()
		}
	})
})
