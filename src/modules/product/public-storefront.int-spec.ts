import { APP_INTERCEPTOR } from '@nestjs/core'
import { INestApplication } from '@nestjs/common'
import { getConnectionToken } from '@nestjs/mongoose'
import mongoose, { mongo } from 'mongoose'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { LandingController } from '../landing/landing.controller'
import { LandingService } from '../landing/landing.service'
import { PublicCatalogController } from './public-catalog.controller'
import { PublicCatalogService } from './public-catalog.service'
import { PublicProductService } from './public-product.service'
import { ProductService } from './product.service'

/**
 * The storefront reads that run while the tree holds v2/draft categories (TD-0013, Plan-0010
 * F06–F08): product page, legacy v1 catalogue, search and landings. Real Mongo, anonymous HTTP,
 * the real interceptor — so the adapted reads are proven to pass the barrier only for what
 * their own visibility rule allows.
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
let app: INestApplication
const productService = {
	getCatalog: jest.fn().mockResolvedValue({ items: [], legacy: true }),
	search: jest.fn().mockResolvedValue({ items: [] }),
	getPriceSheet: jest.fn().mockResolvedValue({ items: [] })
}
const realProducts = new ProductService(
	{} as never,
	{} as never,
	{} as never,
	{} as never,
	{} as never,
	{ revalidate: jest.fn() } as never,
	{ request: jest.fn() } as never
)
const landingRepository = {
	findActive: jest.fn(),
	findActiveSlugs: jest.fn(),
	findActiveByCategoryAndSlug: jest.fn()
}
beforeAll(async () => {
	await connectTestDb('public-storefront')
	const variants = new ProductVariantRepository(
		mongoose.connection.model(ProductVariant.name, ProductVariantSchema)
	)
	const categories = new CategoryPublicReadService(mongoose.connection)
	const products = new PublicProductService(
		mongoose.connection,
		variants,
		categories,
		realProducts
	)
	const catalog = new PublicCatalogService(
		mongoose.connection,
		categories,
		productService as never
	)
	const landings = new LandingService(
		landingRepository as never,
		{
			findBySlug: (slug: string) =>
				mongoose.connection.collection('categories').findOne({ slug })
		} as never,
		{ countVariantsForLandings: jest.fn().mockResolvedValue(new Map()) } as never,
		{ revalidate: jest.fn() } as never,
		categories
	)
	app = await createRbacApp({
		controllers: [PublicCatalogController, LandingController],
		providers: [
			{ provide: PublicCatalogService, useValue: catalog },
			{ provide: PublicProductService, useValue: products },
			{ provide: LandingService, useValue: landings },
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
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 4, epoch: 2 } as never)
	await db.collection('categories').insertMany([
		// Legacy flat v1 category, as production stores it today (no kind/status/version).
		{
			_id: id(1),
			name: 'Філамент',
			slug: 'filament',
			required_attributes: [
				{
					key: 'vaha',
					label: 'Вага',
					filter_type: 'multi-select',
					is_required: false,
					unit: 'кг'
				}
			]
		},
		{
			_id: id(2),
			name: 'Електротовари',
			slug: 'electrical',
			kind: 'group',
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{
			_id: id(3),
			name: 'АВР',
			slug: 'avr',
			parent_id: id(2),
			kind: 'product',
			status: 'active',
			attribute_contract_version: 2,
			// Stored before the name suffix was retired (2026-11-05): never sent to the page.
			presentation: { product_name_suffix: 'для дому' },
			attribute_definitions: [
				definition('current', 'number', { unit: 'А', label: 'Струм', order: 0 }),
				definition('automatic', 'boolean', { label: 'Автоматичний', order: 1 }),
				definition('poles', 'enum', {
					label: 'Полюси',
					order: 2,
					options: [{ id: 'four', label: 'Чотири', order: 0 }]
				}),
				definition('internal', 'string', { visible_in_specs: false, order: 3 })
			]
		},
		{
			_id: id(4),
			name: 'Чернетка',
			slug: 'draft-group',
			kind: 'group',
			status: 'draft',
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{
			_id: id(5),
			name: 'Активна під чернеткою',
			slug: 'hidden-leaf',
			parent_id: id(4),
			kind: 'product',
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: []
		}
	])
	await db.collection('brands').insertOne({ _id: id(60), name: 'Bemko', status: 'active' })
	await db.collection('products').insertMany([
		{
			_id: id(10),
			name: 'Sunlu PLA',
			category_id: id(1),
			vendor_id: id(99),
			variant_type: { key: 'kolir', label: 'Колір' },
			attributes: [
				{ k: 'vaha', l: 'Вага', v: '1' },
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' }
			]
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
				{ k: 'internal', v: 'SUPPLIER-NOTE' }
			],
			variant_axis: { key: 'current' },
			description: { html: '<p>АВР</p>', json: {} }
		},
		{
			_id: id(12),
			name: 'Прихований',
			category_id: id(5),
			attributes: [],
			attributes_v2: [],
			variant_axis: null
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
	await db
		.collection('product_variants')
		.insertMany([
			sku(20, 10, 1, { v_value: 'Black' }),
			sku(21, 11, 3, { variant_value: 16, name: 'АВР Bemko — 16 А' }),
			sku(22, 11, 3, { variant_value: 63, name: 'АВР Bemko — 63 А' }),
			sku(23, 11, 3, { variant_value: 100, status: 'draft' }),
			sku(24, 11, 3, { variant_value: 32, status: 'archived' }),
			sku(25, 12, 5, {})
		])
})

it('keeps the v1 product payload and adds the root-first category path', async () => {
	const response = await send(app, 'get', '/products/by-slug/sku-20')
	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		category_slug: 'filament',
		category_name: 'Філамент',
		category_path: [{ _id: String(id(1)), name: 'Філамент', slug: 'filament' }],
		product: {
			name: 'Sunlu PLA',
			manufacturer: 'Sunlu',
			attributes: expect.arrayContaining([
				{ k: 'vaha', l: 'Вага', v: '1', unit: 'кг' }
			]) as unknown
		},
		variant: { v_value: 'Black', status: 'active' }
	})
	expect(response.body).not.toHaveProperty('typed')
	expect((response.body as { product: object }).product).not.toHaveProperty('attributes_v2')
	expect(JSON.stringify(response.body)).not.toContain('VENDOR-SECRET')
})

it('formats a v2 SKU from its category definitions without supplier or internal fields', async () => {
	const response = await send(app, 'get', '/products/by-slug/sku-21')
	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		category_slug: 'avr',
		category_path: [
			{ name: 'Електротовари', slug: 'electrical' },
			{ name: 'АВР', slug: 'avr' }
		],
		variant: { name: 'АВР Bemko — 16 А', v_value: '16 А', color: null },
		product: {
			name: 'АВР Bemko',
			manufacturer: 'Bemko',
			variant_type: { key: 'current', label: 'Струм' },
			attributes: [
				{ k: 'current', l: 'Струм', v: '16', unit: 'А' },
				{ k: 'automatic', l: 'Автоматичний', v: 'Ні', unit: null },
				{ k: 'poles', l: 'Полюси', v: 'Чотири', unit: null }
			]
		}
	})
	// No category display rules (retired 2026-11-05): the rows above arrive ordered by the
	// definitions and without the one left out of the table.
	expect(response.body).not.toHaveProperty('category_presentation')
	// Active siblings only; each carries its own formatted axis value.
	expect(
		(response.body as { siblings: { slug: string; v_value: string }[] }).siblings.map(row => [
			row.slug,
			row.v_value
		])
	).toEqual(
		expect.arrayContaining([
			['sku-21', '16 А'],
			['sku-22', '63 А']
		])
	)
	expect((response.body as { siblings: unknown[] }).siblings).toHaveLength(2)
	const text = JSON.stringify(response.body)
	for (const secret of ['VENDOR-SECRET', 'SUPPLIER-NOTE', 'four', String(id(99))])
		expect(text).not.toContain(secret)
	expect(response.body).not.toHaveProperty('typed')
})

it('marks a category path too long to embed instead of cutting it (Plan-0010 D06.4)', async () => {
	// 2 500 groups with 200-character names above «Електротовари»: ~1.2 MB of ancestors.
	const deep = Array.from({ length: 2500 }, (_, n) => ({
		_id: id(50_000 + n),
		parent_id: n === 0 ? null : id(50_000 + n - 1),
		name: `Рівень ${n} ${'я'.repeat(190)}`,
		slug: `deep-${n}`,
		kind: 'group',
		status: 'active',
		attribute_contract_version: 2,
		attribute_definitions: []
	}))
	await mongoose.connection.collection('categories').insertMany(deep)
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: id(2) }, { $set: { parent_id: id(50_000 + 2499) } })
	const response = await send(app, 'get', '/products/by-slug/sku-21')
	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		category_path: [{ _id: String(id(3)), name: 'АВР', slug: 'avr' }],
		category_path_paged: true,
		category_path_total: 2502
	})
	expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThan(2 * 1024 * 1024)
	// At an ordinary depth the marker is absent, as before.
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: id(2) }, { $unset: { parent_id: '' } })
	const shallow = await send(app, 'get', '/products/by-slug/sku-21')
	expect(shallow.body).not.toHaveProperty('category_path_paged')
	expect((shallow.body as { category_path: unknown[] }).category_path).toHaveLength(2)
})

it('serves an archived v2 SKU as discontinued, and hides drafts and hidden branches', async () => {
	const archived = await send(app, 'get', '/products/by-slug/sku-24')
	expect(archived.status).toBe(200)
	expect((archived.body as { variant: object }).variant).toMatchObject({
		status: 'archived',
		v_value: '32 А'
	})
	expect((await send(app, 'get', '/products/by-slug/sku-23')).status).toBe(404)
	expect((await send(app, 'get', '/products/by-slug/sku-25')).status).toBe(404)
	expect((await send(app, 'get', '/products/by-slug/missing')).status).toBe(404)
})

it('scopes the legacy catalogue to a visible v1 product category', async () => {
	const legacy = await send(app, 'get', `/products/catalog?category_id=${String(id(1))}`)
	expect(legacy.status).toBe(200)
	expect(productService.getCatalog).toHaveBeenCalledTimes(1)
	const typed = await send(app, 'get', `/products/catalog?category_id=${String(id(3))}`)
	expect(typed.status).toBe(409)
	expect(typed.body).toMatchObject({ details: { code: 'ATTRIBUTE_CONTRACT_UPGRADE_REQUIRED' } })
	for (const hidden of [id(2), id(5), id(77)])
		expect(
			(await send(app, 'get', `/products/catalog?category_id=${String(hidden)}`)).status
		).toBe(404)
	expect(productService.getCatalog).toHaveBeenCalledTimes(1)
})

it('restricts search to visible categories of both contracts', async () => {
	expect((await send(app, 'get', '/products/search?q=sku')).status).toBe(200)
	const [, visible] = productService.search.mock.calls[0] as [unknown, string[]]
	expect([...visible].sort()).toEqual([String(id(1)), String(id(3))])
})

it('restricts the public price sheet to visible categories of both contracts', async () => {
	expect((await send(app, 'get', '/products/price-sheet')).status).toBe(200)
	// The visible categories themselves: a v2 one also formats its products (Plan-0010 B11).
	// Ids only, plus the content of the page's categories on demand (Plan-0010 D06).
	const [, visible] = productService.getPriceSheet.mock.calls[0] as [
		unknown,
		{ ids: string[]; content: (ids: string[]) => Promise<Map<string, unknown>> }
	]
	expect([...visible.ids].sort()).toEqual([String(id(1)), String(id(3))])
	expect([...(await visible.content([String(id(3)), String(id(2))])).keys()]).toEqual([
		String(id(3))
	])
})

it('serves landings of visible v1 categories only', async () => {
	landingRepository.findActive.mockResolvedValue([
		{ _id: id(40), slug: 'pla', category_id: id(1), filters: {} },
		{ _id: id(41), slug: 'typed', category_id: id(3), filters: {} }
	])
	landingRepository.findActiveSlugs.mockResolvedValue([
		{ slug: 'pla', category_slug: 'filament' },
		{ slug: 'typed', category_slug: 'avr' }
	])
	landingRepository.findActiveByCategoryAndSlug.mockResolvedValue({
		toObject: () => ({ slug: 'typed' })
	})
	const list = await send(app, 'get', '/landings')
	expect(list.status).toBe(200)
	expect((list.body as { slug: string }[]).map(row => row.slug)).toEqual(['pla'])
	const slugs = await send(app, 'get', '/landings/slugs')
	expect(slugs.body).toEqual([{ slug: 'pla', category_slug: 'filament' }])
	expect((await send(app, 'get', '/landings/slug/avr/typed')).status).toBe(404)
	expect((await send(app, 'get', '/landings/slug/filament/typed')).status).toBe(200)
})

it('keeps maintenance and drift checks on the adapted product read', async () => {
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'writing' } })
	const busy = await send(app, 'get', '/products/by-slug/sku-21')
	expect(busy.status).toBe(503)
	expect(busy.headers).toMatchObject({ 'retry-after': '5', 'cache-control': 'no-store' })
})

describe('colour axis and typed landings after the v1→v2 migration (TD-0013 B04/B08)', () => {
	beforeEach(async () => {
		const db = mongoose.connection.db!
		await db.collection('colors').insertMany([
			{
				_id: id(70),
				name_uk: 'Чорний',
				name_en: 'Black',
				family: 'black',
				order: 0,
				hex_stops: ['#000000']
			},
			{
				_id: id(71),
				name_uk: 'Білий',
				name_en: 'White',
				family: 'white',
				order: 1,
				hex_stops: ['#ffffff']
			}
		])
		await db.collection('categories').insertOne({
			_id: id(6),
			name: 'Філамент v2',
			slug: 'filament-v2',
			kind: 'product',
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: [
				definition('polymer', 'string', {
					label: 'Тип пластику',
					filter_enabled: true,
					filter_type: 'multi-select',
					semantic: 'material',
					order: 0
				}),
				definition('color', 'string', { label: 'Колір', semantic: 'color', order: 1 })
			]
		})
		await db.collection('products').insertOne({
			_id: id(15),
			name: 'Sunlu PLA',
			category_id: id(6),
			brand_id: id(60),
			attributes_v2: [{ k: 'polymer', v: 'PLA' }],
			variant_axis: { key: 'color' }
		})
		await db.collection('product_variants').insertMany(
			[
				[30, 70, 'black', 'Black'],
				[31, 71, 'white', 'White']
			].map(([n, color, family, v]) => ({
				_id: id(n as number),
				product_id: id(15),
				category_id: id(6),
				name: `Sunlu PLA — ${v as string}`,
				slug: `pla-${family as string}`,
				sku: `FL-${n as number}`,
				price: 400,
				stock: 2,
				images: [],
				status: 'active',
				color_id: id(color as number),
				color_family: family,
				v_value: v,
				variant_value: String(id(color as number))
			}))
		)
	})
	const v2 = (filters: object) =>
		send(
			app,
			'get',
			`/products/catalog/v2?category_id=${String(id(6))}&filters=${encodeURIComponent(JSON.stringify(filters))}`
		)

	it('filters and counts by dictionary family, and carries the colour on items', async () => {
		const all = await v2({})
		expect(all.status).toBe(200)
		const body = all.body as {
			total: number
			items: { color: { family: string } | null }[]
			facets: {
				colors: { family: string; count: number; hex_stops: string[] }[]
				attributes: { key: string }[]
			}
		}
		expect(body.total).toBe(2)
		expect(body.facets.colors).toEqual([
			{ family: 'black', count: 1, hex_stops: ['#000000'] },
			{ family: 'white', count: 1, hex_stops: ['#ffffff'] }
		])
		// The colour axis has no attribute facet: dictionary ids are never offered as values.
		expect(body.facets.attributes.map(row => row.key)).toEqual(['polymer'])
		expect(body.items.every(item => item.color !== null)).toBe(true)
		const black = await v2({ color_families: ['black'] })
		const narrowed = black.body as typeof body
		expect(narrowed.total).toBe(1)
		// Self-excluding: the white family keeps its count while black is ticked.
		expect(narrowed.facets.colors.find(row => row.family === 'white')!.count).toBe(1)
		expect((await v2({ color_families: ['plaid'] })).status).toBe(400)
	})

	it('keeps the dictionary colour on a colour-axis product page', async () => {
		const response = await send(app, 'get', '/products/by-slug/pla-black')
		expect(response.status).toBe(200)
		const body = response.body as {
			variant: { v_value: string; color: { name_uk: string } | null }
			siblings: { color: unknown }[]
			product: { attributes: { k: string; v: string }[]; manufacturer: string }
		}
		expect(body.variant).toMatchObject({ v_value: 'Black', color: { name_uk: 'Чорний' } })
		expect(body.siblings.every(row => row.color !== null)).toBe(true)
		expect(body.product.attributes).toContainEqual(
			expect.objectContaining({ k: 'color', v: 'Чорний (Black)' })
		)
		expect(JSON.stringify(body.product.attributes)).not.toContain(String(id(70)))
		// The axis semantic feeds `variesBy` of the ProductGroup; nothing declares size here.
		expect(response.body).toMatchObject({
			product: { variant_type: { key: 'color', label: 'Колір', semantic: 'color' } },
			// The characteristic marked `material` — the page states what the feed sends.
			semantic_values: { size: null, material: 'PLA' }
		})
	})

	it("shows the refill's own notice and no link to another configuration", async () => {
		const db = mongoose.connection.db!
		await db.collection('categories').updateOne(
			{ _id: id(6) },
			{
				$push: {
					attribute_definitions: definition('spool_included', 'string', {
						label: 'Котушка в комплекті',
						order: 2
					})
				} as never,
				// Stored before the category notices were retired (2026-11-05): never read.
				$set: {
					'presentation.attribute_notes': [
						{
							key: 'spool_included',
							value: 'Так',
							title: 'Категорійне',
							text: 'Не показується.',
							badge: null
						}
					]
				}
			}
		)
		await db.collection('products').insertOne({
			_id: id(16),
			name: 'Sunlu PLA (без котушки)',
			category_id: id(6),
			attributes_v2: [
				{ k: 'polymer', v: 'PLA' },
				{ k: 'spool_included', v: 'Ні (рефіл)' }
			],
			variant_axis: { key: 'color' },
			// The product's own notice (owner, 2026-11-05): written by the migration or the editor.
			purchase_notice: {
				title: 'Це рефіл — без котушки',
				text: 'Потрібна власна котушка.',
				badge: 'Без котушки'
			},
			// Left over from the removed refill ↔ spool link: stored, but never read again.
			spooled_product_id: id(15),
			relations: [
				{
					type: 'alternative_configuration',
					target_product_id: id(15),
					variant_pairs: [{ source_variant_id: id(32), target_variant_id: id(31) }]
				}
			]
		})
		await db.collection('product_variants').insertOne({
			_id: id(32),
			product_id: id(16),
			category_id: id(6),
			name: 'Sunlu PLA (без котушки) — Black',
			slug: 'pla-refill-black',
			sku: 'FL-32',
			price: 350,
			stock: 2,
			images: [],
			status: 'active',
			color_id: id(70),
			v_value: 'Black',
			variant_value: String(id(70))
		})
		const refill = await send(app, 'get', '/products/by-slug/pla-refill-black')
		expect(refill.status).toBe(200)
		expect(refill.body).toMatchObject({
			attribute_notice: {
				title: 'Це рефіл — без котушки',
				text: 'Потрібна власна котушка.',
				badge: 'Без котушки'
			}
		})
		expect(refill.body).not.toHaveProperty('spooled_counterpart')
		expect(refill.body).not.toHaveProperty('category_presentation')
		const spool = await send(app, 'get', '/products/by-slug/pla-black')
		expect(spool.body).toMatchObject({ attribute_notice: null })
	})

	it('takes the manufacturer from the characteristic marked brand, never from its label', async () => {
		const db = mongoose.connection.db!
		await db.collection('categories').updateOne(
			{ _id: id(6) },
			{
				$push: {
					attribute_definitions: definition('vyrobnyk', 'string', {
						label: 'Виробник',
						order: 3
					})
				} as never
			}
		)
		await db.collection('products').updateOne(
			{ _id: id(15) },
			{
				$unset: { brand_id: '' },
				$push: { attributes_v2: { k: 'vyrobnyk', v: 'Sunlu' } } as never
			}
		)
		const manufacturer = async () =>
			(
				(await send(app, 'get', '/products/by-slug/pla-black')).body as {
					product: { manufacturer: string | null }
				}
			).product.manufacturer
		// A «Виробник» label alone names nothing (owner, 2026-11-05).
		expect(await manufacturer()).toBeNull()
		await db.collection('categories').updateOne(
			{ _id: id(6), 'attribute_definitions.key': 'vyrobnyk' },
			{
				$set: {
					'attribute_definitions.$.semantic': 'brand',
					'attribute_definitions.$.visible_in_specs': false
				}
			}
		)
		// Marked brand — and hidden from the table, as filament's «Виробник» is.
		expect(await manufacturer()).toBe('Sunlu')
	})

	it('serves a v2 category landing only with typed pins', async () => {
		landingRepository.findActive.mockResolvedValue([
			{
				_id: id(50),
				slug: 'typed',
				category_id: id(6),
				filters: {},
				contract_version: 2,
				filters_v2: { attributes: [] }
			},
			{ _id: id(51), slug: 'untyped', category_id: id(6), filters: { polymer: ['PLA'] } }
		])
		const list = await send(app, 'get', '/landings')
		expect((list.body as { slug: string }[]).map(row => row.slug)).toEqual(['typed'])
	})
})
