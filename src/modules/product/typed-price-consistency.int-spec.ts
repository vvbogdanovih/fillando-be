import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import mongoose, { mongo } from 'mongoose'
import request from 'supertest'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { Landing, LandingSchema } from 'src/database/mongoose/schemas/landing.schema'
import { Order, OrderSchema } from 'src/database/mongoose/schemas/order.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { FeedService, feedXmlOf } from '../feed/feed.service'
import { PublicCatalogController } from './public-catalog.controller'
import { PublicCatalogService } from './public-catalog.service'
import { PublicProductService } from './public-product.service'
import { ProductService } from './product.service'
import { TypedProductController, TypedProductService } from './typed-product.controller'

/**
 * Plan-0010 §5 «Ціна/акція/наявність», backend half (owner decision 31.10.2026): an admin price
 * and promotion change through the typed product writer is what the product page reads, what the
 * catalogue card reads and what the Google feed carries — one effective price, and the storefront
 * purge requested. The browser half (`fillando-fe/e2e/release/price-purge.spec.ts`) checks the
 * rendered page and structured data after the purge.
 */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
const SLUG = 'kyshenkovyi-lihtar'
let app: INestApplication
let feed: FeedService

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	const conn = await connectTestDb('typed-price-consistency')
	const variantModel = conn.model(ProductVariant.name, ProductVariantSchema)
	const variants = new ProductVariantRepository(variantModel)
	const categories = new CategoryPublicReadService(conn.connection)
	// Only `legacyDetail` (pure mapping) of the legacy service is reached by the product page read.
	const legacy = new ProductService(
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ revalidate: jest.fn() } as never,
		{ request: jest.fn() } as never
	)
	app = await createRbacApp({
		controllers: [TypedProductController, PublicCatalogController],
		providers: [
			TypedProductService,
			{
				provide: PublicCatalogService,
				useValue: new PublicCatalogService(conn.connection, categories, legacy)
			},
			{
				provide: PublicProductService,
				useValue: new PublicProductService(conn.connection, variants, categories, legacy)
			},
			{ provide: getConnectionToken(), useValue: conn.connection },
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor },
			{
				provide: APP_PIPE,
				useValue: new ValidationPipe({ whitelist: true, transform: true })
			}
		]
	})
	feed = new FeedService(
		variants,
		new LandingRepository(conn.model(Landing.name, LandingSchema)),
		new OrderRepository(conn.model(Order.name, OrderSchema)),
		new LegacyCatalogWritePolicy(conn.connection),
		categories
	)
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
	await db().collection('numbers').insertOne({ sku: 500 })
	await db()
		.collection('categories')
		.insertOne({
			_id: oid(1),
			name: 'Ліхтарі',
			slug: 'torches',
			kind: 'product',
			parent_id: null,
			status: 'active',
			order: 0,
			attribute_contract_version: 2,
			required_attributes: [],
			attribute_definitions: [
				{
					key: 'manufacturer',
					label: 'Виробник',
					value_type: 'string',
					unit: null,
					is_required: false,
					filter_enabled: false,
					filter_type: null,
					visible_in_specs: true,
					order: 0,
					multiple: false,
					// The feed names a v2 brand only from the characteristic marked brand.
					semantic: 'brand',
					options: []
				}
			]
		})
	await db()
		.collection('products')
		.insertOne({
			_id: oid(10),
			name: 'Ліхтар кишеньковий',
			category_id: oid(1),
			vendor_id: null,
			description: { html: '<p>Кишеньковий ліхтар.</p>', json: {} },
			attributes: [],
			attributes_v2: [{ k: 'manufacturer', v: 'Промінь' }],
			variant_axis: null
		})
	await db()
		.collection('product_variants')
		.insertOne({
			_id: oid(20),
			product_id: oid(10),
			category_id: oid(1),
			name: 'Ліхтар кишеньковий',
			slug: SLUG,
			sku: 'FL-000420',
			price: 500,
			stock: 5,
			images: ['https://cdn.example.invalid/torch.webp'],
			status: 'active',
			variant_value: null
		})
})

/** The admin card save: the price and a promotion, everything else as stored. */
async function changePrice(price: number, promo: { percent: number; ends: string } | null) {
	const server = app.getHttpServer() as Server
	const path = `/products/${id(10)}/admin/typed-draft`
	const draft = (await request(server).get(path).set('x-test-role', 'ADMIN')).body as {
		revision: number
		name: string
		attributes_v2: unknown[]
		variant_axis: unknown
		variants: { id: string; variant_value: unknown }[]
		details: { token: string; variants: Record<string, unknown>[] }
	}
	return request(server)
		.patch(path)
		.set('Idempotency-Key', randomUUID())
		.set('x-test-role', 'ADMIN')
		.send({
			expected_revision: draft.revision,
			name: draft.name,
			attributes_v2: draft.attributes_v2,
			variant_axis: draft.variant_axis,
			variants: draft.variants.map(row => ({ id: row.id, variant_value: row.variant_value })),
			details: {
				token: draft.details.token,
				description: { html: '<p>Кишеньковий ліхтар.</p>', json: {} },
				variants: draft.details.variants.map(row => ({
					...row,
					price,
					...(promo
						? { promo_percent: promo.percent, promo_ends_at: promo.ends }
						: { promo_percent: null })
				}))
			}
		})
}

/** Regular and effective price as the product page, the catalogue card and the feed see them. */
async function everywhere() {
	const server = app.getHttpServer() as Server
	const page = (await request(server).get(`/products/by-slug/${SLUG}`)).body as {
		variant: { price: number; sale_price: number | null }
	}
	const card = (
		(await request(server).get(`/products/catalog/v2?category_id=${id(1)}`)).body as {
			items: { slug: string; price: number; sale_price: number | null }[]
		}
	).items.find(item => item.slug === SLUG)!
	await feed.generate()
	const item = feedXmlOf(feed.getXml()!)
		.split('</item>')
		.find(row => row.includes('<g:id>FL-000420</g:id>'))!
	const tag = (name: string) => item.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? null
	return {
		page: [page.variant.price, page.variant.sale_price],
		card: [card.price, card.sale_price],
		feed: [tag('g:price'), tag('g:sale_price')]
	}
}

it('an admin price and promotion change: page, card and feed carry the same prices', async () => {
	const purge = jest.spyOn(storefrontRevalidation, 'revalidate').mockImplementation(() => {})
	try {
		expect(await everywhere()).toEqual({
			page: [500, null],
			card: [500, null],
			feed: ['500.00 UAH', null]
		})

		const ends = new Date(Date.now() + 7 * 86_400_000).toISOString()
		expect((await changePrice(650, { percent: 20, ends })).status).toBe(200)
		expect(purge).toHaveBeenCalledWith('products', expect.any(String))
		expect(await everywhere()).toEqual({
			page: [650, 520],
			card: [650, 520],
			feed: ['650.00 UAH', '520.00 UAH']
		})

		expect((await changePrice(480, null)).status).toBe(200)
		expect(await everywhere()).toEqual({
			page: [480, null],
			card: [480, null],
			feed: ['480.00 UAH', null]
		})
	} finally {
		purge.mockRestore()
	}
})
