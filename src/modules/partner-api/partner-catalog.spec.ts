import type { Server } from 'node:http'
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import { Types } from 'mongoose'
import request from 'supertest'
import {
	PartnerCatalogRepository,
	PartnerCatalogRow
} from 'src/database/mongoose/repositories/partner-catalog.repository'
import { PartnerCatalogController } from './partner-catalog.controller'
import { PartnerCatalogService } from './partner-catalog.service'
import { PartnerApiService } from './partner-api.service'
import { PartnerApiController } from './partner-api.controller'

const categoryId = new Types.ObjectId().toString()
const row: PartnerCatalogRow = {
	sku: 'A',
	name: 'PLA Black',
	slug: 'pla-black',
	stock: 0,
	stock_updated_at: null,
	images: ['https://example.invalid/a.jpg'],
	weight_g: 1200,
	v_value: 'Black',
	category: { _id: new Types.ObjectId(categoryId), name: 'Filament', slug: 'filament' },
	product: {
		description: { html: '<p>PLA</p>' },
		attributes: [{ k: 'spool', l: 'Котушка', v: false }],
		variant_type: { key: 'color', label: 'Колір' }
	}
}
const repository = {
	categories: jest.fn(),
	categoryExists: jest.fn(),
	skus: jest.fn(),
	lookup: jest.fn()
}
const auth = {
	authenticate: jest.fn((header?: string) =>
		header === 'Bearer test'
			? Promise.resolve('partner')
			: Promise.reject(new UnauthorizedException())
	),
	availability: jest.fn().mockResolvedValue({ sku: 'A' })
}

describe('Partner catalogue HTTP', () => {
	let app: INestApplication
	beforeEach(async () => {
		jest.clearAllMocks()
		repository.categories.mockResolvedValue([
			{ id: categoryId, name: 'Filament', slug: 'filament', parent_id: null, sku_count: 1 }
		])
		repository.categoryExists.mockResolvedValue({ _id: categoryId })
		repository.skus.mockResolvedValue([{ sku: 'A' }, { sku: 'B' }])
		repository.lookup.mockResolvedValue([row])
		const mod = await Test.createTestingModule({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ ttl: 60000, limit: 20 }],
					skipIf: () => true
				})
			],
			controllers: [PartnerCatalogController, PartnerApiController],
			providers: [
				PartnerCatalogService,
				{ provide: PartnerCatalogRepository, useValue: repository },
				{ provide: PartnerApiService, useValue: auth }
			]
		}).compile()
		app = mod.createNestApplication({ logger: false })
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
		await app.listen(0, '127.0.0.1')
	})
	afterEach(async () => app.close())
	const get = (path: string) =>
		request(app.getHttpServer() as Server)
			.get('/partner/v1/' + path)
			.set('Authorization', 'Bearer test')
	const lookup = (body: object) =>
		request(app.getHttpServer() as Server)
			.post('/partner/v1/products/lookup')
			.set('Authorization', 'Bearer test')
			.send(body)
	const postSkus = (body: object) =>
		request(app.getHttpServer() as Server)
			.post('/partner/v1/products/skus')
			.set('Authorization', 'Bearer test')
			.send(body)
	const postCategories = () =>
		request(app.getHttpServer() as Server)
			.post('/partner/v1/categories')
			.set('Authorization', 'Bearer test')
			.send({})
	it('does not expose GET categories or GET skus', async () => {
		expect((await get('categories')).status).toBe(404)
		expect((await get('products/skus')).status).toBe(404)
		expect(repository.categories).not.toHaveBeenCalled()
		expect(repository.skus).not.toHaveBeenCalled()
	})
	it('reads category, cursor and limit from JSON and defaults an empty object', async () => {
		const first = await postSkus({ category_id: categoryId, limit: 1 })
		expect(first.status).toBe(200)
		expect(first.headers['cache-control']).toBe('no-store')
		const body = first.body as { items: string[]; next_cursor: string }
		expect(body.items).toEqual(['A'])
		repository.skus.mockResolvedValue([])
		expect(
			(await postSkus({ category_id: categoryId, cursor: body.next_cursor })).body
		).toEqual({ items: [], next_cursor: null })
		expect(repository.skus).toHaveBeenLastCalledWith(categoryId, 'A', 100)
		expect((await postSkus({ cursor: body.next_cursor })).status).toBe(400)
		expect((await postSkus({})).status).toBe(200)
		expect(repository.skus).toHaveBeenLastCalledWith(undefined, undefined, 100)
	})
	it.each([
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ limit: true },
		{ limit: '10' },
		{ limit: null },
		{ category_id: 'bad' },
		{ cursor: 'bad' }
	])('validates SKU JSON body %j', async body => {
		expect((await postSkus(body)).status).toBe(400)
		expect(repository.skus).not.toHaveBeenCalled()
	})
	it('requires bearer auth for POST skus', async () => {
		expect(
			(
				await request(app.getHttpServer() as Server)
					.post('/partner/v1/products/skus')
					.send({})
			).status
		).toBe(401)
		expect(repository.skus).not.toHaveBeenCalled()
	})
	it('returns categories and explicit empty-category counts without caching', async () => {
		repository.categories.mockResolvedValue([
			{ id: categoryId, name: 'Empty', slug: 'empty', parent_id: null, sku_count: 0 }
		])
		const res = await postCategories()
		expect(res.status).toBe(200)
		expect(res.body).toEqual([
			{ id: categoryId, name: 'Empty', slug: 'empty', parent_id: null, sku_count: 0 }
		])
		expect(res.headers['cache-control']).toBe('no-store')
	})
	it('returns 404 for an unknown category', async () => {
		repository.categoryExists.mockResolvedValue(null)
		expect((await postSkus({ category_id: categoryId })).status).toBe(404)
		expect(repository.skus).not.toHaveBeenCalled()
	})
	it('returns ordered public cards and deduplicated not_found', async () => {
		repository.lookup.mockResolvedValue([
			{
				...row,
				price: 123,
				vendor_id: 'secret',
				prom_id: 'secret',
				product: { ...row.product, vendor_id: 'secret' }
			}
		])
		const res = await lookup({ skus: ['missing', 'A', 'A', 'missing'] })
		expect(res.status).toBe(200)
		expect(res.headers['cache-control']).toBe('no-store')
		expect(res.body).toEqual({
			items: [
				{
					sku: 'A',
					name: 'PLA Black',
					description_html: '<p>PLA</p>',
					category: { id: categoryId, name: 'Filament', slug: 'filament' },
					attributes: [{ key: 'spool', label: 'Котушка', value: false }],
					variant: { key: 'color', label: 'Колір', value: 'Black' },
					images: row.images,
					url: expect.stringMatching(/\/products\/pla-black$/) as string,
					weight_g: 1200,
					availability: { sku: 'A', in_stock: false, quantity: 0, stock_updated_at: null }
				}
			],
			not_found: ['missing']
		})
		expect(repository.lookup).toHaveBeenCalledTimes(1)
		expect(repository.lookup).toHaveBeenCalledWith(['missing', 'A'])
	})
	it('accepts 100 SKUs and returns 200 when all are missing', async () => {
		repository.lookup.mockResolvedValue([])
		const skus = Array.from({ length: 100 }, (_, i) => 'SKU-' + i)
		expect((await lookup({ skus })).body).toEqual({ items: [], not_found: skus })
	})
	it.each([
		{},
		{ skus: [] },
		{ skus: Array(101).fill('A') },
		{ skus: [''] },
		{ skus: [123] },
		{ skus: [{ $ne: null }] }
	])('rejects invalid lookup %j', async body => {
		expect((await lookup(body)).status).toBe(400)
		expect(repository.lookup).not.toHaveBeenCalled()
	})
	it('protects all three routes with bearer authentication', async () => {
		for (const path of ['categories', 'products/skus']) {
			expect(
				(
					await request(app.getHttpServer() as Server)
						.post('/partner/v1/' + path)
						.send({})
				).status
			).toBe(401)
		}
		expect(
			(
				await request(app.getHttpServer() as Server)
					.post('/partner/v1/products/lookup')
					.send({ skus: ['A'] })
			).status
		).toBe(401)
		expect(repository.categories).not.toHaveBeenCalled()
		expect(repository.skus).not.toHaveBeenCalled()
		expect(repository.lookup).not.toHaveBeenCalled()
	})
	it('shares the existing stock API quota across controllers', async () => {
		for (let i = 0; i < 15; i++) {
			expect((await postCategories()).status).toBe(200)
			expect((await postSkus({})).status).toBe(200)
			expect((await lookup({ skus: ['A'] })).status).toBe(200)
			expect((await get('products/A/availability')).status).toBe(200)
		}
		const res = await postCategories()
		expect(res.status).toBe(429)
		expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
	})
})
