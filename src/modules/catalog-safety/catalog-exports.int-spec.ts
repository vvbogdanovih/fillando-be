import mongoose from 'mongoose'
import { INestApplication, UnauthorizedException } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import request from 'supertest'
import type { Server } from 'node:http'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import { FeedService, feedXmlOf } from '../feed/feed.service'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import type { FeedRawRow } from '../feed/feed.types'
import { PartnerCatalogController } from '../partner-api/partner-catalog.controller'
import { PartnerApiController } from '../partner-api/partner-api.controller'
import { PartnerCatalogService } from '../partner-api/partner-catalog.service'
import { PartnerApiService } from '../partner-api/partner-api.service'
import {
	LegacyCatalogWritePolicy,
	LegacyCatalogWriteInterceptor
} from './legacy-catalog-write.interceptor'
const row = (overrides: Partial<FeedRawRow> = {}): FeedRawRow => ({
	id: 'v1',
	product_id: 'p1',
	sku: 'FL-000001',
	name: 'Kingroon PLA — Чорний (Black)',
	slug: 'kingroon-pla-black',
	price: 419,
	promo_percent: null,
	promo_ends_at: null,
	stock: 12,
	images: ['https://cdn.example.invalid/1.jpg'],
	v_value: 'Black',
	weight_g: 1220,
	product: {
		name: 'Kingroon PLA',
		description_html: '<p>PLA</p>',
		attributes: [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }
		],
		variant_type: null
	},
	category: {
		id: 'c1',
		name: 'Філамент',
		google_product_category: { id: 499682, path: 'Electronics > …' },
		required_attributes: []
	},
	color: { name_uk: 'Чорний', name_en: 'Black' },
	...overrides
})

let policy: LegacyCatalogWritePolicy, feed: FeedService, app: INestApplication
const rows = jest.fn()
/** The repository's cursor over the mocked rows; `rows` is read only once it is iterated. */
const cursor = {
	findActiveForFeed: () =>
		(async function* () {
			yield* (await rows()) as FeedRawRow[]
		})(),
	// No grouped product in these fixtures (one SKU per product).
	findGroupedProductIds: () => Promise.resolve(new Set<string>())
}
const partnerRead = jest.fn()
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('catalog-exports')
	const module = await Test.createTestingModule({
		imports: [
			ThrottlerModule.forRoot({
				throttlers: [{ ttl: 60000, limit: 1000 }],
				skipIf: () => true
			})
		],
		controllers: [PartnerCatalogController, PartnerApiController],
		providers: [
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor },
			{
				provide: PartnerCatalogService,
				useValue: { categories: partnerRead, skus: partnerRead, lookup: partnerRead }
			},
			{
				provide: PartnerApiService,
				useValue: {
					authenticate: (header?: string) => {
						if (header !== 'Bearer test') throw new UnauthorizedException()
						return 'test-partner'
					},
					availability: partnerRead,
					bulkAvailability: partnerRead
				}
			}
		]
	}).compile()
	app = module.createNestApplication({ logger: false })
	await app.init()
	policy = app.get(LegacyCatalogWritePolicy)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	rows.mockReset().mockResolvedValue([row()])
	partnerRead.mockReset().mockResolvedValue({ ok: true })
	feed = new FeedService(
		cursor as never,
		{ findActive: jest.fn().mockResolvedValue([]) } as never,
		{ countSoldByVariantSince: jest.fn().mockResolvedValue(new Map()) } as never,
		policy
	)
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
async function changeEpoch() {
	await mongoose.connection.collection('catalog_control').updateOne({}, { $inc: { epoch: 1 } })
}
/** What a completed operation does to the stamp (`publishVerified`). */
async function publishWrite() {
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $inc: { revision: 1, epoch: 1 } })
}
it('publishes and serves a verified generic feed', async () => {
	await control()
	await feed.generate()
	expect(feedXmlOf((await feed.getVerifiedXml())!)).toContain('Каталог товарів Fillando')
	expect(feed.isRunning).toBe(false)
})
it('does not start domain reads during maintenance', async () => {
	await control('writing')
	await expect(feed.generate()).rejects.toMatchObject({ status: 503 })
	expect(rows).not.toHaveBeenCalled()
	expect(feed.getXml()).toBeNull()
	expect(feed.isRunning).toBe(false)
})
it('never replaces the previous artifact when the catalog changes during generation', async () => {
	await control()
	await feed.generate()
	const previous = feed.getXml()
	rows.mockImplementationOnce(async () => {
		await publishWrite()
		return [row({ name: 'Partial result' })]
	})
	await expect(feed.generate()).rejects.toMatchObject({ status: 503 })
	expect(feed.getXml()).toEqual(previous)
	const requested = jest.spyOn(feedRefresh, 'request').mockImplementation(() => undefined)
	await expect(feed.getVerifiedXml()).rejects.toMatchObject({
		response: { details: { code: 'CATALOG_FEED_STALE' } }
	})
	// Another process (the release CLI) changed the catalogue: the stale stamp queues a rebuild.
	expect(requested).toHaveBeenCalledWith('stale catalogue stamp')
	requested.mockRestore()
	await feed.generate()
	expect(await feed.getVerifiedXml()).not.toBeNull()
})
it('keeps serving the feed after an operation that changed nothing (audit 11.11)', async () => {
	await control()
	await feed.generate()
	const served = feed.getXml()
	// Aborted or rolled back: the gate moves the epoch alone, the data is what the feed was built from.
	await changeEpoch()
	const requested = jest.spyOn(feedRefresh, 'request').mockImplementation(() => undefined)
	expect(await feed.getVerifiedXml()).toEqual(served)
	expect(requested).not.toHaveBeenCalled()
	requested.mockRestore()
	// A completed one moves the revision: the old feed is not served.
	await publishWrite()
	await expect(feed.getVerifiedXml()).rejects.toMatchObject({
		response: { details: { code: 'CATALOG_FEED_STALE' } }
	})
})
it('refuses an old artifact after bootstrap even if counters remain zero', async () => {
	await feed.generate()
	await control()
	await expect(feed.getVerifiedXml()).rejects.toMatchObject({ status: 503 })
})
it('does not expose an old feed during a write or under incompatible v2 data', async () => {
	await control()
	await feed.generate()
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'writing' } })
	await expect(feed.getVerifiedXml()).rejects.toMatchObject({ status: 503 })
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'idle' } })
	await mongoose.connection.collection('categories').insertOne({ attribute_contract_version: 2 })
	await expect(feed.getVerifiedXml()).rejects.toMatchObject({ status: 503 })
})
it('protects all partner reads while preserving authentication precedence', async () => {
	await control('writing')
	const server = app.getHttpServer() as Server
	expect((await request(server).post('/partner/v1/categories').send({})).status).toBe(401)
	for (const path of [
		'categories',
		'products/skus',
		'products/lookup',
		'products/availability'
	]) {
		const response = await request(server)
			.post(`/partner/v1/${path}`)
			.set('Authorization', 'Bearer test')
			.send({ skus: ['A'] })
		expect({ path, status: response.status }).toEqual({ path, status: 503 })
		expect(response.headers['retry-after']).toBe('5')
	}
	const single = await request(server)
		.get('/partner/v1/products/A/availability')
		.set('Authorization', 'Bearer test')
	expect(single.status).toBe(503)
	expect(partnerRead).not.toHaveBeenCalled()
})
it('keeps read-only partner POST available when idle and discards a changed response', async () => {
	await control()
	const server = app.getHttpServer() as Server
	expect(
		(
			await request(server)
				.post('/partner/v1/categories')
				.set('Authorization', 'Bearer test')
				.send({})
		).status
	).toBe(200)
	partnerRead.mockImplementationOnce(async () => {
		await changeEpoch()
		return { partial: true }
	})
	const response = await request(server)
		.post('/partner/v1/categories')
		.set('Authorization', 'Bearer test')
		.send({})
	expect(response.status).toBe(503)
	expect(response.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
	expect(response.body).not.toHaveProperty('partial')
})

describe('typed feed adapter (TD-0013)', () => {
	const ids = {
		avr: '00000000000000000000a001',
		draft: '00000000000000000000a002',
		hidden: '00000000000000000000a003',
		filament: '00000000000000000000a004'
	}
	beforeEach(async () => {
		await control()
		const oid = (id: string) => new mongoose.Types.ObjectId(id)
		const v2 = { attribute_contract_version: 2, kind: 'product', status: 'active' }
		await mongoose.connection.collection('categories').insertMany([
			{ _id: oid(ids.filament), name: 'Філамент', slug: 'filament' },
			{
				_id: oid(ids.avr),
				name: 'АВР',
				slug: 'avr',
				...v2,
				attribute_definitions: [
					{
						key: 'current',
						label: 'Струм',
						value_type: 'number',
						unit: 'А',
						is_required: true,
						filter_enabled: false,
						filter_type: null,
						visible_in_specs: true,
						order: 0,
						multiple: false,
						semantic: 'generic',
						options: []
					}
				]
			},
			{
				_id: oid(ids.draft),
				name: 'Чернетка',
				slug: 'draft',
				kind: 'group',
				status: 'draft',
				attribute_contract_version: 2,
				attribute_definitions: []
			},
			{
				_id: oid(ids.hidden),
				name: 'Прихована',
				slug: 'hidden',
				parent_id: oid(ids.draft),
				...v2,
				attribute_definitions: []
			}
		])
		rows.mockResolvedValue([
			row({ category: { ...row().category!, id: ids.filament } }),
			row({
				id: 'v2',
				sku: 'FL-000305',
				name: 'АВР Bemko — 63 А',
				slug: 'avr-bemko-63-a',
				v_value: null,
				color: null,
				variant_value: 63,
				product: {
					name: 'АВР Bemko',
					description_html: '<p>АВР</p>',
					attributes: [],
					variant_type: null,
					attributes_v2: [],
					variant_axis: { key: 'current' },
					brand_name: 'Bemko'
				},
				category: {
					id: ids.avr,
					name: 'АВР',
					google_product_category: null,
					required_attributes: []
				}
			}),
			row({
				id: 'v3',
				sku: 'FL-HIDDEN',
				slug: 'hidden-sku',
				category: { ...row().category!, id: ids.hidden }
			})
		])
		feed = new FeedService(
			cursor as never,
			{ findActive: jest.fn().mockResolvedValue([]) } as never,
			{ countSoldByVariantSince: jest.fn().mockResolvedValue(new Map()) } as never,
			policy,
			new CategoryPublicReadService(mongoose.connection)
		)
	})
	it('exports public v1 and v2 SKUs, formats the typed axis and never invents a colour', async () => {
		const summary = await feed.generate()
		expect(summary.item_count).toBe(2)
		const xml = feedXmlOf((await feed.getVerifiedXml())!)
		expect(xml).toContain('FL-000001')
		expect(xml).toContain('FL-000305')
		expect(xml).not.toContain('FL-HIDDEN')
		const typedItem = xml.slice(xml.indexOf('FL-000305'))
		const item = typedItem.slice(0, typedItem.indexOf('</item>'))
		expect(item).toContain('63 А')
		expect(item).not.toContain('<g:color>')
		expect(item).toContain('Bemko')
	})
	it('sends the size semantic of the axis and the computed labels (B10)', async () => {
		await mongoose.connection
			.collection('categories')
			.updateOne(
				{ _id: new mongoose.Types.ObjectId(ids.avr) },
				{ $set: { 'attribute_definitions.0.semantic': 'size' } }
			)
		await feed.generate()
		const xml = feedXmlOf((await feed.getVerifiedXml())!)
		const typedItem = xml.slice(xml.indexOf('FL-000305'))
		const item = typedItem.slice(0, typedItem.indexOf('</item>'))
		expect(item).toContain('<g:size>63 А</g:size>')
		// No per-category labels (owner, 04.11.2026): every label is the computed one.
		expect(item).toContain('<g:custom_label_0>basic</g:custom_label_0>')
	})
	it('excludes a typed SKU without a brand entity instead of inventing one', async () => {
		const [legacy, typed] = (await rows()) as FeedRawRow[]
		rows.mockResolvedValue([
			legacy,
			{ ...typed, product: { ...typed.product!, brand_name: null } } as never
		])
		const summary = await feed.generate()
		expect(summary.excluded).toEqual([
			expect.objectContaining({ sku: 'FL-000305', reason: 'missing_brand' })
		])
	})
})
