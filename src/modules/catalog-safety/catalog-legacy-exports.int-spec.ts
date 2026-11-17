import { APP_INTERCEPTOR } from '@nestjs/core'
import { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import mongoose, { mongo } from 'mongoose'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { Category, CategorySchema } from 'src/database/mongoose/schemas/category.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import {
	PartnerApiToken,
	PartnerApiTokenSchema
} from 'src/database/mongoose/schemas/partner-api-token.schema'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { PartnerCatalogRepository } from 'src/database/mongoose/repositories/partner-catalog.repository'
import { PartnerApiRepository } from 'src/database/mongoose/repositories/partner-api.repository'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { PartnerCatalogController } from '../partner-api/partner-catalog.controller'
import { PartnerApiController } from '../partner-api/partner-api.controller'
import { PartnerCatalogService } from '../partner-api/partner-catalog.service'
import { PartnerApiService } from '../partner-api/partner-api.service'
import {
	PartnerApiGuard,
	PartnerIpThrottlerGuard,
	PartnerTokenThrottlerGuard
} from '../partner-api/partner-api.guard'
import { ProductController } from '../product/product.controller'
import { ProductService } from '../product/product.service'
import { PriceListService } from '../product/price-list/price-list.service'
import { PromSyncService } from '../prom/prom-sync.service'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from './legacy-catalog-write.interceptor'

/**
 * The last legacy-shaped consumers of the catalogue (Plan-0010 B11): the partner API, the admin
 * price list PDF, the public price sheet and the Prom sync, on a tree holding a migrated v2
 * filament, a v2 group with a typed category, a hidden branch and a flat v1 category. Real Mongo,
 * real repositories and services, the real catalogue interceptor; only auth and the PDF renderer
 * are stand-ins. Before this block each of these reads answered 503 as soon as any v2 data existed.
 */
const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
const definition = (
	key: string,
	value_type: 'number' | 'boolean' | 'enum' | 'string',
	extra: Record<string, unknown> = {}
) => ({
	key,
	label: key.toUpperCase(),
	value_type,
	unit: null,
	is_required: false,
	multiple: false,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	semantic: 'generic',
	options: [],
	...extra
})
const partner = { authorization: 'Bearer test' }
let app: INestApplication
let categories: CategoryPublicReadService
let variants: ProductVariantRepository
const pdf = { generatePdf: jest.fn((html: string) => Promise.resolve(Buffer.from(html))) }

beforeAll(async () => {
	await connectTestDb('catalog-legacy-exports')
	const variantModel = mongoose.connection.model(ProductVariant.name, ProductVariantSchema)
	const categoryModel = mongoose.connection.model(Category.name, CategorySchema)
	const tokenModel = mongoose.connection.model(PartnerApiToken.name, PartnerApiTokenSchema)
	categories = new CategoryPublicReadService(mongoose.connection)
	variants = new ProductVariantRepository(variantModel)
	const partnerApi = new PartnerApiService(
		new PartnerApiRepository(tokenModel, variantModel),
		categories
	)
	jest.spyOn(partnerApi, 'authenticate').mockImplementation(header =>
		header === partner.authorization ? Promise.resolve('token') : Promise.reject(Error())
	)
	app = await createRbacApp({
		controllers: [PartnerCatalogController, PartnerApiController, ProductController],
		providers: [
			{
				provide: PartnerCatalogService,
				useValue: new PartnerCatalogService(
					new PartnerCatalogRepository(categoryModel, variantModel),
					categories
				)
			},
			{ provide: PartnerApiService, useValue: partnerApi },
			PartnerApiGuard,
			PartnerIpThrottlerGuard,
			PartnerTokenThrottlerGuard,
			{ provide: ProductService, useValue: {} },
			{
				provide: PriceListService,
				useValue: new PriceListService(variants, {} as never, pdf as never, categories)
			},
			{ provide: getConnectionToken(), useValue: mongoose.connection },
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
	jest.clearAllMocks()
	await mongoose.connection.dropDatabase()
	const db = mongoose.connection.db!
	await db
		.collection<{ _id: string }>('catalog_control')
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 7, epoch: 3 } as never)
	await db.collection('categories').insertMany([
		// The filament after `catalog-v2-migrate.cjs`: same keys, numbers with units, a colour axis
		// keyed `color`, «Матеріал»/«Виробник» hidden only by presentation, legacy fields kept.
		{
			_id: id(1),
			name: 'Філамент',
			slug: 'filament',
			order: 1,
			kind: 'product',
			status: 'active',
			attribute_contract_version: 2,
			required_attributes: [{ key: 'vaha', label: 'Вага філаменту', unit: 'кг' }],
			// As migrated (owner, 2026-11-05): «Виробник» is the characteristic marked brand, and it
			// and «Матеріал» are left out of the page's table only — the exports keep them.
			attribute_definitions: [
				definition('vyrobnyk', 'string', {
					label: 'Виробник',
					order: 0,
					semantic: 'brand',
					visible_in_specs: false
				}),
				definition('vaha', 'number', { label: 'Вага філаменту', unit: 'кг', order: 1 }),
				definition('diametr', 'number', { label: 'Діаметр', unit: 'мм', order: 2 }),
				definition('kolir', 'string', { label: 'Колір', order: 3 }),
				definition('material', 'string', {
					label: 'Матеріал',
					order: 4,
					visible_in_specs: false
				}),
				definition('color', 'string', { label: 'Колір', semantic: 'color', order: 5 })
			]
		},
		{
			_id: id(2),
			name: 'Електротовари',
			slug: 'electrical',
			order: 2,
			kind: 'group',
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{
			_id: id(3),
			name: 'АВР',
			slug: 'avr',
			order: 3,
			parent_id: id(2),
			kind: 'product',
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: [
				definition('current', 'number', { unit: 'А', label: 'Струм', order: 0 }),
				definition('automatic', 'boolean', { label: 'Автоматичний', order: 1 }),
				definition('poles', 'enum', {
					label: 'Полюси',
					order: 2,
					options: [{ id: 'four', label: 'Чотири', order: 0 }]
				}),
				definition('note', 'string', {
					label: 'Примітка',
					visible_in_specs: false,
					order: 3
				})
			]
		},
		{
			_id: id(4),
			name: 'Чернетка',
			slug: 'draft-group',
			order: 4,
			kind: 'group',
			status: 'draft',
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{
			_id: id(5),
			name: 'Активна під чернеткою',
			slug: 'hidden-leaf',
			order: 5,
			parent_id: id(4),
			kind: 'product',
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		// A flat v1 category as production stores it today.
		{ _id: id(6), name: 'Легасі', slug: 'legacy', order: 6, required_attributes: [] }
	])
	await db.collection('brands').insertOne({ _id: id(60), name: 'Bemko', status: 'active' })
	await db.collection('colors').insertMany([
		{ _id: id(70), name_uk: 'Чорний', name_en: 'Black', family: 'black' },
		{ _id: id(71), name_uk: 'Білий', name_en: 'White', family: 'white' }
	])
	await db.collection('products').insertMany([
		{
			_id: id(10),
			name: 'Kingroon PETG',
			category_id: id(1),
			vendor_id: id(99),
			// The rollback image: legacy rows, including the stale product-level colour copy.
			attributes: [
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
				{ k: 'vaha', l: 'Вага філаменту', v: '1' },
				{ k: 'diametr', l: 'Діаметр', v: '1.75' },
				{ k: 'material', l: 'Матеріал', v: 'PETG' },
				{ k: 'kolir', l: 'Колір', v: 'Чорний' }
			],
			variant_type: { key: 'kolir', label: 'Колір' },
			attributes_v2: [
				{ k: 'vyrobnyk', v: 'Kingroon' },
				{ k: 'vaha', v: 1 },
				{ k: 'diametr', v: 1.75 },
				{ k: 'material', v: 'PETG' }
			],
			variant_axis: { key: 'color' },
			description: { html: '<p>PETG</p>', json: {} }
		},
		{
			_id: id(13),
			name: 'Kingroon PA',
			category_id: id(1),
			vendor_id: id(99),
			attributes: [{ k: 'kolir', l: 'Колір', v: 'Матова веселка' }],
			variant_type: null,
			attributes_v2: [
				{ k: 'vyrobnyk', v: 'Kingroon' },
				{ k: 'kolir', v: 'Матова веселка' }
			],
			variant_axis: null
		},
		{
			_id: id(11),
			name: 'АВР Bemko',
			category_id: id(3),
			vendor_id: id(99),
			brand_id: id(60),
			attributes: [],
			attributes_v2: [
				{ k: 'automatic', v: false },
				{ k: 'poles', v: 'four' },
				{ k: 'note', v: 'Не в таблиці' }
			],
			variant_axis: { key: 'current' }
		},
		{
			_id: id(12),
			name: 'Прихований',
			category_id: id(5),
			attributes: [],
			attributes_v2: [],
			variant_axis: null
		},
		{
			_id: id(14),
			name: 'Legacy PLA',
			category_id: id(6),
			vendor_id: id(99),
			attributes: [{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' }],
			variant_type: { key: 'kolir', label: 'Колір' }
		}
	])
	const sku = (n: number, product: number, category: number, extra: object) => ({
		_id: id(n),
		product_id: id(product),
		category_id: id(category),
		name: `SKU ${n}`,
		slug: `sku-${n}`,
		sku: `FL-${n}`,
		price: 100 * n,
		stock: 1,
		images: [],
		status: 'active',
		vendor_product_sku: 'VENDOR-SECRET',
		prom_base_price: 1,
		...extra
	})
	await db.collection('product_variants').insertMany([
		sku(20, 10, 1, {
			name: 'Kingroon PETG — Чорний (Black)',
			v_value: 'Black',
			variant_value: String(id(70)),
			color_id: id(70),
			color_family: 'black',
			prom_id: '111'
		}),
		sku(26, 10, 1, {
			name: 'Kingroon PETG — Білий (White)',
			v_value: 'White',
			variant_value: String(id(71)),
			color_id: id(71),
			color_family: 'white',
			stock: 0,
			prom_id: '112'
		}),
		sku(27, 10, 1, { status: 'draft', v_value: 'Black', variant_value: String(id(70)) }),
		sku(28, 13, 1, { name: 'Kingroon PA', v_value: null, variant_value: null }),
		sku(21, 11, 3, { variant_value: 16, name: 'АВР Bemko — 16 А' }),
		sku(22, 11, 3, { variant_value: 63, name: 'АВР Bemko — 63 А' }),
		sku(23, 11, 3, { variant_value: 100, status: 'draft' }),
		sku(25, 12, 5, {}),
		sku(29, 14, 6, { name: 'Legacy PLA — Red', v_value: 'Red' })
	])
})

describe('partner API over the transition', () => {
	const post = (path: string, body: object) =>
		send(app, 'post', `/partner/v1/${path}`, { body }).set(partner)

	it('lists the visible product categories flat, with their exportable SKU counts', async () => {
		const response = await post('categories', {})
		expect(response.status).toBe(200)
		expect(response.body).toEqual([
			{
				id: String(id(1)),
				name: 'Філамент',
				slug: 'filament',
				parent_id: null,
				sku_count: 3
			},
			{ id: String(id(3)), name: 'АВР', slug: 'avr', parent_id: null, sku_count: 2 },
			{ id: String(id(6)), name: 'Легасі', slug: 'legacy', parent_id: null, sku_count: 1 }
		])
	})

	it('enumerates SKUs of visible categories only; a group or hidden category is 404', async () => {
		const all = await post('products/skus', { limit: 100 })
		expect(all.body).toEqual({
			items: ['FL-20', 'FL-21', 'FL-22', 'FL-26', 'FL-28', 'FL-29'],
			next_cursor: null
		})
		const filament = await post('products/skus', { category_id: String(id(1)), limit: 100 })
		expect((filament.body as { items: string[] }).items).toEqual(['FL-20', 'FL-26', 'FL-28'])
		for (const category of [id(2), id(5)])
			expect(
				(await post('products/skus', { category_id: String(category), limit: 100 })).status
			).toBe(404)
	})

	it('answers a migrated product in the legacy shape; a hidden SKU is not found', async () => {
		const response = await post('products/lookup', {
			skus: ['FL-20', 'FL-26', 'FL-28', 'FL-21', 'FL-29', 'FL-25', 'FL-27']
		})
		expect(response.status).toBe(200)
		const body = response.body as { items: { sku: string }[]; not_found: string[] }
		const bySku = Object.fromEntries(body.items.map(item => [item.sku, item]))
		expect(body.not_found).toEqual(['FL-25', 'FL-27'])
		// Same keys, labels, text values and order as the legacy rows; the colour variant keeps
		// the v1 key `kolir` and the dictionary name, and the product-level «Колір» row is the
		// SKU's own colour where the legacy card had the stale copy (owner decision 2026-10-28).
		expect(bySku['FL-20']).toMatchObject({
			name: 'Kingroon PETG — Чорний (Black)',
			description_html: '<p>PETG</p>',
			category: { id: String(id(1)), name: 'Філамент', slug: 'filament' },
			attributes: [
				{ key: 'vyrobnyk', label: 'Виробник', value: 'Kingroon' },
				{ key: 'vaha', label: 'Вага філаменту', value: '1' },
				{ key: 'diametr', label: 'Діаметр', value: '1.75' },
				{ key: 'material', label: 'Матеріал', value: 'PETG' },
				{ key: 'kolir', label: 'Колір', value: 'Чорний' }
			],
			variant: { key: 'kolir', label: 'Колір', value: 'Black' }
		})
		// The legacy copy said «Чорний» on the white SKU too; the card now names its own colour.
		expect(bySku['FL-26']).toMatchObject({
			attributes: [
				{ key: 'vyrobnyk', label: 'Виробник', value: 'Kingroon' },
				{ key: 'vaha', label: 'Вага філаменту', value: '1' },
				{ key: 'diametr', label: 'Діаметр', value: '1.75' },
				{ key: 'material', label: 'Матеріал', value: 'PETG' },
				{ key: 'kolir', label: 'Колір', value: 'Білий' }
			],
			variant: { key: 'kolir', label: 'Колір', value: 'White' }
		})
		// Without an axis the product-level colour is a real description and stays.
		expect(bySku['FL-28']).toMatchObject({
			attributes: [
				{ key: 'vyrobnyk', label: 'Виробник', value: 'Kingroon' },
				{ key: 'kolir', label: 'Колір', value: 'Матова веселка' }
			],
			variant: null
		})
		// A typed category: the brand entity first, enum label, Так/Ні, formatted axis value,
		// never a colour. One visibility switch (owner, 2026-11-05): a characteristic left out
		// of the page's table is still exported, as «Матеріал» and «Виробник» always were.
		expect(bySku['FL-21']).toMatchObject({
			attributes: [
				{ key: 'brand', label: 'Виробник', value: 'Bemko' },
				{ key: 'automatic', label: 'Автоматичний', value: 'Ні' },
				{ key: 'poles', label: 'Полюси', value: 'Чотири' },
				{ key: 'note', label: 'Примітка', value: 'Не в таблиці' }
			],
			variant: { key: 'current', label: 'Струм', value: '16 А' }
		})
		expect(bySku['FL-29']).toMatchObject({
			attributes: [{ key: 'vyrobnyk', label: 'Виробник', value: 'Sunlu' }],
			variant: { key: 'kolir', label: 'Колір', value: 'Red' }
		})
		const text = JSON.stringify(response.body)
		for (const secret of ['VENDOR-SECRET', 'prom_', 'vendor_id', 'four'])
			expect(text).not.toContain(secret)
	})

	it('answers availability only for SKUs of visible categories', async () => {
		const bulk = await post('products/availability', { skus: ['FL-20', 'FL-25', 'FL-26'] })
		expect(bulk.status).toBe(200)
		const availability = bulk.body as { items: { sku: string }[]; not_found: string[] }
		expect(availability.items.map(item => item.sku)).toEqual(['FL-20', 'FL-26'])
		expect(availability.not_found).toEqual(['FL-25'])
		const single = (sku: string) =>
			send(app, 'get', `/partner/v1/products/${sku}/availability`).set(partner)
		expect((await single('FL-21')).body).toMatchObject({ sku: 'FL-21', quantity: 1 })
		expect((await single('FL-25')).status).toBe(404)
	})

	it('keeps the maintenance barrier', async () => {
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $set: { phase: 'writing' } })
		const response = await post('categories', {})
		expect(response.status).toBe(503)
		expect(response.body).toMatchObject({ details: { code: 'CATALOG_MAINTENANCE' } })
	})
})

describe('admin price list PDF over the transition', () => {
	const html = async (body: object) => {
		const response = await send(app, 'post', '/products/price-list/pdf', {
			role: 'ADMIN',
			body
		}).buffer(true)
		expect(response.status).toBe(201)
		return (response.body as Buffer).toString('utf8')
	}

	it('lists SKUs of visible categories with brand and variant columns from typed values', async () => {
		const document = await html({})
		for (const sku of ['FL-20', 'FL-26', 'FL-28', 'FL-21', 'FL-22', 'FL-29'])
			expect(document).toContain(sku)
		for (const hidden of ['FL-25', 'FL-27', 'FL-23']) expect(document).not.toContain(hidden)
		expect(document).toContain('Чорний (Black)')
		expect(document).toContain('16 А')
		// One table per category, in catalogue order (owner, 2026-11-06): each with its heading.
		const sections = ['<h2>Філамент</h2>', '<h2>АВР</h2>', '<h2>Легасі</h2>'].map(heading =>
			document.indexOf(heading)
		)
		expect(sections[0]).toBeGreaterThan(-1)
		expect(sections[0]).toBeLessThan(sections[1])
		expect(sections[1]).toBeLessThan(sections[2])
		expect(document.indexOf('Kingroon PA')).toBeLessThan(sections[1])
		expect(document.indexOf('АВР Bemko')).toBeGreaterThan(sections[1])
		expect(document.indexOf('Legacy PLA')).toBeGreaterThan(sections[2])
		// No characteristic of the АВР is a filter here, so its variation keeps a column.
		expect(document.slice(sections[1], sections[2])).toContain('<th>Варіант</th>')
	})

	it('ignores a requested hidden category and names only visible ones', async () => {
		const document = await html({ category_ids: [String(id(3)), String(id(5))] })
		expect(document).toContain('FL-21')
		expect(document).not.toContain('FL-25')
		expect(document).toContain('АВР')
		expect(document).not.toContain('Активна під чернеткою')
		const onlyHidden = await send(app, 'post', '/products/price-list/pdf', {
			role: 'ADMIN',
			body: { category_ids: [String(id(5))] }
		})
		expect(onlyHidden.status).toBe(400)
	})
})

describe('public price sheet columns from typed values', () => {
	it('reads manufacturer, the variant label and the category columns of v2 products', async () => {
		const service = new ProductService(
			{} as never,
			variants,
			{} as never,
			{} as never,
			{} as never,
			{ revalidate: jest.fn() } as never,
			{ request: jest.fn() } as never
		)
		// What PublicCatalogService passes: visible ids, and the content of a page's categories.
		const visible = async () => {
			const nodes = await categories.productCategories()
			return {
				ids: nodes.map(node => node._id),
				content: (ids: string[]) => categories.contentOf(ids, { of: nodes })
			}
		}
		const sheet = await service.getPriceSheet({ limit: 50 }, await visible())
		const bySku = Object.fromEntries(
			(sheet.items as { article: string }[]).map(item => [item.article, item])
		)
		expect(sheet.items.map((item: { article: string | null }) => item.article).sort()).toEqual([
			'FL-20',
			'FL-21',
			'FL-22',
			'FL-26',
			'FL-28',
			'FL-29'
		])
		expect(bySku['FL-20']).toMatchObject({
			manufacturer: 'Kingroon',
			// Deprecated: a typed category shows its own columns (owner, 2026-11-06).
			material: null,
			color: 'Чорний (Black)',
			variant_label: 'Чорний (Black)',
			category_id: String(id(1)),
			// The only column of this fixture's filament: no characteristic has a filter here.
			values: { color: 'Чорний (Black)' }
		})
		expect(bySku['FL-21']).toMatchObject({
			manufacturer: 'Bemko',
			material: null,
			color: null,
			variant_label: '16 А',
			values: {}
		})
		// One category after another, each with its columns: what the catalogue filters it by.
		expect(sheet.categories).toEqual([
			{
				id: String(id(1)),
				name: 'Філамент',
				columns: [{ key: 'color', label: 'Колір' }],
				// The colour axis is a column: no «Варіант».
				variant_column: false
			},
			// The current axis is not a filter here, and a v1 category has no columns at all.
			{ id: String(id(3)), name: 'АВР', columns: [], variant_column: true },
			{ id: String(id(6)), name: 'Легасі', columns: [], variant_column: true }
		])
		expect(sheet.items.map((item: { category_id: string }) => item.category_id)).toEqual(
			[...sheet.items.map((item: { category_id: string }) => item.category_id)].sort()
		)
		// The typed inputs of these columns never reach the response themselves.
		for (const key of ['attributes_v2', 'variant_axis', 'variant_value', 'brand_name'])
			expect(Object.keys(bySku['FL-21'])).not.toContain(key)
		expect(JSON.stringify(sheet)).not.toContain('SUPPLIER-NOTE')
		// An edit through the typed editor reaches the sheet: legacy rows are not read for v2.
		await mongoose.connection
			.collection('products')
			.updateOne({ _id: id(10) }, { $set: { 'attributes_v2.0.v': 'Kingroon Pro' } })
		const edited = await service.getPriceSheet(
			{ q: 'Kingroon Pro', limit: 50 },
			await visible()
		)
		expect(edited.items.map((item: { article: string | null }) => item.article).sort()).toEqual(
			['FL-20', 'FL-26']
		)
		expect(edited.items[0]).toMatchObject({ manufacturer: 'Kingroon Pro' })
	})
})

describe('Prom sync on migrated SKUs', () => {
	const prom = {
		getProduct: jest.fn((promId: string) =>
			Promise.resolve({
				id: Number(promId),
				presence: 'available',
				quantity_in_stock: 7,
				price: 500,
				discount: null
			})
		)
	}
	const sync = () =>
		new PromSyncService(
			prom as never,
			variants,
			{ revalidate: jest.fn() } as never,
			mongoose.connection
		)

	it('writes only price/stock and their stamps; typed and identity fields stay', async () => {
		const before = await mongoose.connection
			.collection('product_variants')
			.findOne({ _id: id(20) })
		const summary = await sync().syncAvailability()
		expect(summary).toMatchObject({ total: 2, updated: 2, deferred: 0, errors: 0 })
		const after = await mongoose.connection
			.collection('product_variants')
			.findOne({ _id: id(20) })
		expect(after).toMatchObject({ stock: 7, prom_base_price: 500 })
		const changed = Object.keys(after!).filter(
			key => JSON.stringify(after![key]) !== JSON.stringify(before![key])
		)
		const narrow = ['price', 'price_updated_at', 'prom_base_price', 'stock', 'stock_updated_at']
		expect(changed.filter(key => !narrow.includes(key) && key !== 'updatedAt')).toEqual([])
		for (const key of [
			'name',
			'slug',
			'sku',
			'variant_value',
			'color_id',
			'category_id',
			'status'
		])
			expect(after![key]).toEqual(before![key])
	})

	it('defers writes while a structural catalogue operation holds the catalogue', async () => {
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $set: { phase: 'writing' } })
		const summary = await sync().syncAvailability()
		expect(summary).toMatchObject({ total: 2, updated: 0, deferred: 2, errors: 0 })
		expect(
			await mongoose.connection.collection('product_variants').findOne({ _id: id(20) })
		).toMatchObject({ stock: 1, price: 2000 })
	})
})
