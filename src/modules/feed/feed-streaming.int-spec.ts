import mongoose, { mongo } from 'mongoose'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getLoggerToken } from 'nestjs-pino'
import request from 'supertest'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { ENV } from 'src/common/constants'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import {
	ProductVariantRepository,
	type FeedVariantRow
} from 'src/database/mongoose/repositories/product-variant.repository'
import { Landing, LandingSchema } from 'src/database/mongoose/schemas/landing.schema'
import { Order, OrderSchema } from 'src/database/mongoose/schemas/order.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { LegacyCatalogWritePolicy } from '../catalog-safety/legacy-catalog-write.interceptor'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { FormerCategoryPublicReadService } from '../category/__former__/category-public-read.former'
import { adaptFeedRow } from './feed-typed-adapter'
import { FeedController } from './feed.controller'
import { FeedService, feedXmlOf } from './feed.service'
import type { FeedExclusion, FeedRawRow, FeedWarningCode } from './feed.types'
import { buildFeedXml, buildItem, SALES_WINDOW_DAYS } from './google-shopping-feed.builder'
import { resolveProductType, type LandingForProductType } from './product-type.resolver'

/**
 * Plan-0010 D06: the feed is generated from a cursor and kept compressed. These specs pin the
 * streamed generation to the one it replaced — the working set read as one sorted array, every
 * item kept and joined — on a mixed catalogue: v1 and v2 categories, a hidden branch, colour and
 * numeric axes, promotions (open-ended, dated, ended, rounding to nothing), zero/negative/missing
 * stock, every exclusion reason, landings refining `product_type` (v1 pins and typed v2 pins),
 * sales velocity, and enough rows to make the compressor flush many times. Same instant, same
 * bytes — not even the dates are stripped.
 */
const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
const day = 24 * 3600 * 1000

/** The working-set pipeline as it was before D06: joins first, `$sort` last, one array. */
const FORMER_PIPELINE = [
	{ $match: { status: 'active' } },
	{
		$lookup: {
			from: 'products',
			localField: 'product_id',
			foreignField: '_id',
			as: 'product',
			pipeline: [
				{
					$lookup: {
						from: 'brands',
						localField: 'brand_id',
						foreignField: '_id',
						as: 'brand',
						pipeline: [
							{ $match: { status: 'active' } },
							{ $project: { _id: 0, name: 1 } }
						]
					}
				},
				{
					$project: {
						_id: 0,
						name: 1,
						brand_name: { $ifNull: [{ $arrayElemAt: ['$brand.name', 0] }, null] },
						description_html: { $ifNull: ['$description.html', null] },
						attributes: { $ifNull: ['$attributes', []] },
						variant_type: { $ifNull: ['$variant_type', null] },
						attributes_v2: { $ifNull: ['$attributes_v2', []] },
						variant_axis: { $ifNull: ['$variant_axis', null] }
					}
				}
			]
		}
	},
	{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
	{
		$lookup: {
			from: 'categories',
			localField: 'category_id',
			foreignField: '_id',
			as: 'category',
			pipeline: [
				{
					$project: {
						_id: 0,
						id: { $toString: '$_id' },
						name: 1,
						google_product_category: { $ifNull: ['$google_product_category', null] },
						required_attributes: '$required_attributes'
					}
				}
			]
		}
	},
	{ $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
	{
		$lookup: {
			from: 'colors',
			localField: 'color_id',
			foreignField: '_id',
			as: 'color',
			pipeline: [{ $project: { _id: 0, name_uk: 1, name_en: 1 } }]
		}
	},
	{ $unwind: { path: '$color', preserveNullAndEmptyArrays: true } },
	{
		$project: {
			_id: 0,
			id: { $toString: '$_id' },
			product_id: { $toString: '$product_id' },
			sku: 1,
			name: 1,
			slug: 1,
			price: 1,
			promo_percent: { $ifNull: ['$promo_percent', null] },
			promo_ends_at: { $ifNull: ['$promo_ends_at', null] },
			stock: { $ifNull: ['$stock', 0] },
			images: { $ifNull: ['$images', []] },
			v_value: { $ifNull: ['$v_value', null] },
			weight_g: { $ifNull: ['$weight_g', null] },
			variant_value: { $ifNull: ['$variant_value', null] },
			product: { $ifNull: ['$product', null] },
			category: { $ifNull: ['$category', null] },
			color: { $ifNull: ['$color', null] }
		}
	},
	{ $sort: { sku: 1 } }
]

let variants: ProductVariantRepository
let landingRepo: LandingRepository
let orders: OrderRepository
let policy: LegacyCatalogWritePolicy
let variantModel: mongoose.Model<ProductVariant>

/**
 * The generation before D06, verbatim except for its inputs: every row in one array, the items
 * collected and joined by `buildFeedXml`, every exclusion listed.
 */
async function formerFeed(reader: FormerCategoryPublicReadService, generatedAt: Date) {
	const since = new Date(Date.now() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000)
	const [allRows, allLandings, unitsSold, publicCategories] = await Promise.all([
		variantModel
			.aggregate<FeedVariantRow>(FORMER_PIPELINE as never)
			.allowDiskUse(true)
			.exec(),
		landingRepo.findActive(),
		orders.countSoldByVariantSince(since),
		reader.findAll()
	])
	const visible = publicCategories
		? new Map(publicCategories.map(category => [category._id, category]))
		: null
	const rows: FeedRawRow[] = visible
		? allRows.flatMap(row => {
				const category = row.category ? visible.get(row.category.id) : undefined
				return category ? [adaptFeedRow(row, category)] : []
			})
		: allRows
	const landings = visible
		? allLandings.filter(landing => {
				const version = visible.get(String(landing.category_id))?.attribute_contract_version
				return version === 1 || (version === 2 && landing.contract_version === 2)
			})
		: allLandings
	const landingViews: LandingForProductType[] = landings.map(l => ({
		category_id: String(l.category_id),
		h1: l.h1,
		order: l.order ?? 0,
		filters: l.filters ?? {}
	}))
	const frontendUrl = ENV.FRONTEND_URL.replace(/\/$/, '')
	// Grouping by active variants per product (TD-0013 D04, 31.10) — an input like the others.
	const variantsOf = new Map<string, number>()
	for (const row of allRows)
		variantsOf.set(row.product_id, (variantsOf.get(row.product_id) ?? 0) + 1)
	const items: string[] = []
	const excluded: FeedExclusion[] = []
	const warnings = new Map<
		FeedWarningCode,
		{ items: number; skus: string[]; cats: Set<string> }
	>()
	let inStock = 0
	let outOfStock = 0
	let typedByLanding = 0
	let warnedItems = 0
	for (const row of rows) {
		const typed =
			row.category && row.product
				? resolveProductType(
						row.category.name,
						row.category.id,
						row.product.attributes ?? [],
						landingViews
					)
				: { product_type: '', landing: null }
		const built = buildItem(row, {
			frontendUrl,
			productType: typed.product_type,
			inGroup: (variantsOf.get(row.product_id) ?? 0) > 1,
			unitsSold: unitsSold.get(row.id) ?? 0,
			now: generatedAt
		})
		if (!built.ok) {
			excluded.push({ sku: row.sku, name: row.name, reason: built.reason })
			continue
		}
		items.push(built.xml)
		if (typed.landing) typedByLanding++
		if ((row.stock ?? 0) > 0) inStock++
		else outOfStock++
		if (built.warnings.length > 0) warnedItems++
		for (const code of built.warnings) {
			const entry = warnings.get(code) ?? { items: 0, skus: [], cats: new Set<string>() }
			entry.items++
			if (row.category) entry.cats.add(row.category.id)
			if (entry.skus.length < 20) entry.skus.push(row.sku)
			warnings.set(code, entry)
		}
	}
	const xml = buildFeedXml(items, {
		title: 'Fillando',
		link: frontendUrl,
		description: 'Каталог товарів Fillando',
		generatedAt
	})
	return {
		xml,
		rows: rows.length,
		items: items.length,
		inStock,
		outOfStock,
		typedByLanding,
		warnedItems,
		excluded,
		warnings: new Map([...warnings].map(([code, e]) => [code, [e.items, e.skus, e.cats.size]]))
	}
}

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	const conn = await connectTestDb('feed-streaming')
	variantModel = conn.model(ProductVariant.name, ProductVariantSchema)
	const landingModel = conn.model(Landing.name, LandingSchema)
	const orderModel = conn.model(Order.name, OrderSchema)
	await Promise.all([variantModel.init(), landingModel.init(), orderModel.init()])
	variants = new ProductVariantRepository(variantModel)
	landingRepo = new LandingRepository(landingModel)
	orders = new OrderRepository(orderModel)
	policy = new LegacyCatalogWritePolicy(conn.connection)
})
afterAll(async () => {
	await dropTestDb(mongoose)
})

beforeAll(async () => {
	const db = mongoose.connection
	await db
		.collection('catalog_control')
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 2, epoch: 1 } as never)
	const definition = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
		key,
		label,
		value_type: 'string',
		unit: null,
		is_required: false,
		filter_enabled: false,
		filter_type: null,
		visible_in_specs: true,
		order: 0,
		multiple: false,
		semantic: 'generic',
		options: [],
		...extra
	})
	const v2 = { attribute_contract_version: 2, kind: 'product', status: 'active' }
	await db.collection('colors').insertMany([
		{ _id: id(901), name_uk: 'Чорний', name_en: 'Black', slug: 'black', family: 'black' },
		{ _id: id(902), name_uk: 'Білий', name_en: 'White', slug: 'white', family: 'white' },
		{ _id: id(903), name_uk: 'Сірий', name_en: 'Сірий', slug: 'gray', family: 'gray' }
	])
	await db.collection('categories').insertMany([
		{
			_id: id(1),
			name: 'Філамент',
			slug: 'filament',
			google_product_category: { id: 499682, path: 'Electronics > 3D Printer Accessories' },
			required_attributes: [
				{
					key: 'vyrobnyk',
					label: 'Виробник',
					filter_type: 'multi-select',
					is_required: true
				},
				{
					key: 'polymer',
					label: 'Тип пластику',
					filter_type: 'multi-select',
					is_required: true
				},
				{
					key: 'diametr',
					label: 'Діаметр',
					filter_type: 'multi-select',
					is_required: true,
					unit: 'мм'
				},
				{
					key: 'vaha',
					label: 'Вага',
					filter_type: 'multi-select',
					is_required: false,
					unit: 'кг'
				},
				{
					key: 'finish',
					label: 'Ефект поверхні',
					filter_type: 'multi-select',
					is_required: false
				}
			]
		},
		{ _id: id(2), name: 'Аксесуари', slug: 'accessories', required_attributes: [] },
		{ _id: id(3), name: 'Електрика', slug: 'electric', kind: 'group' },
		{
			_id: id(4),
			name: 'АВР',
			slug: 'avr',
			parent_id: id(3),
			...v2,
			attribute_definitions: [
				definition('vyrobnyk', 'Виробник', { semantic: 'brand' }),
				definition('current', 'Струм', {
					value_type: 'number',
					unit: 'А',
					semantic: 'size',
					is_required: true,
					order: 1
				}),
				definition('material', 'Матеріал', { semantic: 'material', order: 2 }),
				definition('phases', 'Фази', { value_type: 'number', is_required: true, order: 3 })
			]
		},
		{
			_id: id(5),
			name: 'Ковдри',
			slug: 'blankets',
			parent_id: id(3),
			...v2,
			attribute_definitions: [
				definition('vyrobnyk', 'Виробник', { semantic: 'brand' }),
				definition('color', 'Колір', { semantic: 'color', order: 1 })
			]
		},
		{ _id: id(6), name: 'Приховане', slug: 'hidden', kind: 'group', status: 'draft' },
		{
			_id: id(7),
			name: 'Прихована категорія',
			slug: 'hidden-leaf',
			parent_id: id(6),
			...v2,
			attribute_definitions: [definition('vyrobnyk', 'Виробник', { semantic: 'brand' })]
		},
		{
			_id: id(8),
			name: 'Без бренду у специфікації',
			slug: 'no-brand-spec',
			parent_id: id(3),
			...v2,
			// A «Виробник» characteristic not marked brand names no brand (owner, 2026-11-05).
			attribute_definitions: [definition('vyrobnyk', 'Виробник', { visible_in_specs: false })]
		}
	])
	const filament = (n: number, extra: Record<string, unknown> = {}) => ({
		_id: id(100 + n),
		name: `Kingroon PLA ${n}`,
		category_id: id(1),
		description: { html: `<p>PLA <b>${n}</b> &amp; ще</p>`, json: {} },
		attributes: [
			{ k: 'vyrobnyk', l: 'Виробник', v: n % 2 ? 'Kingroon' : 'Sunlu' },
			{ k: 'polymer', l: 'Тип пластику', v: n % 3 ? 'PLA' : 'PETG' },
			{ k: 'diametr', l: 'Діаметр', v: '1.75' },
			{ k: 'vaha', l: 'Вага', v: n % 5 ? '1' : '' },
			...(n % 4 === 0 ? [{ k: 'finish', l: 'Ефект поверхні', v: 'Silk' }] : [])
		],
		variant_type: { key: 'color', label: 'Колір' },
		...extra
	})
	await db.collection('products').insertMany([
		...Array.from({ length: 12 }, (_, n) => filament(n)),
		filament(12, {
			attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }],
			name: 'Без виробника'
		}),
		{
			_id: id(150),
			name: 'Тримач котушки',
			category_id: id(2),
			description: { html: '', json: {} },
			attributes: [{ k: 'vyrobnyk', l: 'Виробник', v: 'Fillando Lab' }],
			variant_type: null
		},
		{
			_id: id(160),
			name: 'АВР Bemko',
			category_id: id(4),
			description: { html: '<p>АВР</p>', json: {} },
			attributes: [],
			attributes_v2: [
				{ k: 'vyrobnyk', v: 'Bemko' },
				{ k: 'material', v: 'Сталь' },
				{ k: 'phases', v: 3 }
			],
			variant_axis: { key: 'current' }
		},
		{
			_id: id(161),
			name: 'АВР без фаз',
			category_id: id(4),
			description: { html: '<p>АВР</p>', json: {} },
			attributes: [],
			attributes_v2: [{ k: 'vyrobnyk', v: 'Bemko' }],
			variant_axis: { key: 'current' }
		},
		{
			_id: id(170),
			name: 'Ковдра Тепло',
			category_id: id(5),
			description: { html: '<p>Ковдра</p>', json: {} },
			attributes: [],
			attributes_v2: [{ k: 'vyrobnyk', v: 'Тепло' }],
			variant_axis: { key: 'color' }
		},
		{
			_id: id(180),
			name: 'Прихований товар',
			category_id: id(7),
			attributes: [],
			attributes_v2: [{ k: 'vyrobnyk', v: 'X' }],
			variant_axis: null
		},
		{
			_id: id(190),
			name: 'Товар із прихованим виробником',
			category_id: id(8),
			attributes: [],
			attributes_v2: [{ k: 'vyrobnyk', v: 'Y' }],
			variant_axis: null
		}
	])
	type Row = Record<string, unknown>
	const rows: Row[] = []
	let n = 0
	const sku = (fields: Row) => {
		n++
		rows.push({
			_id: id(10_000 + n),
			name: `SKU ${n}`,
			// Inserted out of SKU order on purpose: the order must come from the sort.
			sku: `FD-${String((n * 7919) % 100_000).padStart(5, '0')}`,
			slug: `sku-${n}`,
			price: 300 + (n % 9) * 50,
			stock: [5, 0, 12, -1, 3, undefined, 30][n % 7],
			images:
				n % 11 === 0
					? []
					: [
							`https://cdn.example.invalid/${n}-a.jpg`,
							`https://cdn.example.invalid/${n}-b.jpg`
						],
			status: 'active',
			weight_g: n % 6 === 0 ? null : 1000 + n,
			vendor_product_sku: 'SECRET',
			...fields
		})
	}
	const colors = [id(901), id(902), id(903)]
	for (let p = 0; p < 13; p++)
		for (let c = 0; c < 3; c++)
			sku({
				product_id: id(100 + p),
				category_id: id(1),
				color_id: colors[c],
				v_value: ['Black', 'White', 'Сірий'][c]
			})
	for (let k = 0; k < 4; k++)
		sku({
			product_id: id(150),
			category_id: id(2),
			v_value: null,
			...(k === 3 ? { price: 0 } : {})
		})
	for (const current of [16, 32, 63])
		sku({
			product_id: id(160),
			category_id: id(4),
			variant_value: current,
			v_value: String(current)
		})
	sku({ product_id: id(161), category_id: id(4), variant_value: 25, v_value: '25' })
	for (let c = 0; c < 3; c++)
		sku({
			product_id: id(170),
			category_id: id(5),
			color_id: colors[c],
			variant_value: String(colors[c]),
			v_value: ['Black', 'White', 'Сірий'][c]
		})
	sku({ product_id: id(180), category_id: id(7) })
	sku({ product_id: id(190), category_id: id(8) })
	sku({ product_id: id(999), category_id: id(1) }) // dangling product
	sku({ product_id: id(101), category_id: id(998) }) // dangling category
	sku({ product_id: id(101), category_id: id(1), status: 'draft' })
	sku({ product_id: id(101), category_id: id(1), status: 'archived' })
	// Bulk filament: the compressor flushes many times (~1.3 KB per item).
	for (let k = 0; k < 600; k++)
		sku({
			product_id: id(100 + (k % 12)),
			category_id: id(1),
			color_id: colors[k % 3],
			v_value: ['Black', 'White', 'Сірий'][k % 3]
		})
	// Promotions (TD-0012): open-ended, dated, ended, rounding to nothing.
	Object.assign(rows[1], { promo_percent: 20 })
	Object.assign(rows[4], { promo_percent: 15, promo_ends_at: new Date(Date.now() + 3 * day) })
	Object.assign(rows[7], { promo_percent: 30, promo_ends_at: new Date(Date.now() - day) })
	Object.assign(rows[10], { promo_percent: 10, price: 1 })
	Object.assign(rows[41], { promo_percent: 25 }) // v1 accessory
	Object.assign(rows[44], { promo_percent: 12, promo_ends_at: new Date(Date.now() + day) }) // v2
	await variantModel.collection.insertMany(rows)
	await db.collection('landings').insertMany([
		{
			category_id: id(1),
			slug: 'pla',
			h1: 'PLA філамент',
			order: 1,
			status: 'active',
			filters: { polymer: ['PLA'] }
		},
		{
			category_id: id(1),
			slug: 'pla-silk',
			h1: 'Silk PLA',
			order: 2,
			status: 'active',
			filters: { polymer: ['PLA'], finish: ['Silk'] }
		},
		{
			category_id: id(1),
			slug: 'petg-draft',
			h1: 'Чернетка',
			order: 0,
			status: 'draft',
			filters: { polymer: ['PETG'] }
		},
		{
			category_id: id(4),
			slug: 'avr-63',
			h1: 'АВР 63 А',
			order: 1,
			status: 'active',
			contract_version: 2,
			filters: { current: ['63'] },
			filters_v2: { attributes: [{ key: 'current', min: 63, max: 63 }] }
		},
		{
			// A legacy-pinned landing over a v2 category: never used for product_type.
			category_id: id(4),
			slug: 'avr-legacy',
			h1: 'АВР (старий)',
			order: 0,
			status: 'active',
			filters: { current: ['16'] }
		}
	])
	const variantOf = (index: number) => rows[index]._id
	await db.collection('orders').insertMany([
		{
			order_number: 1,
			payment_status: 'PAID',
			createdAt: new Date(Date.now() - 5 * day),
			items: [
				{ variant_id: variantOf(0), quantity: 12 },
				{ variant_id: variantOf(2), quantity: 3 },
				{ variant_id: variantOf(43), quantity: 4 }
			]
		},
		{
			order_number: 2,
			payment_status: 'PENDING',
			createdAt: new Date(Date.now() - day),
			items: [{ variant_id: variantOf(5), quantity: 50 }]
		},
		{
			order_number: 3,
			payment_status: 'PAID',
			createdAt: new Date(Date.now() - 200 * day),
			items: [{ variant_id: variantOf(6), quantity: 50 }]
		}
	])
})

// The API always reads through the public category projection (FeedModule imports it); without
// it the legacy barrier refuses v2 data outright, which `catalog-exports.int-spec.ts` pins.
describe('streamed feed = former feed (public categories, v1 and v2)', () => {
	let feed: FeedService
	let reader: CategoryPublicReadService
	beforeAll(() => {
		reader = new CategoryPublicReadService(mongoose.connection)
		feed = new FeedService(variants, landingRepo, orders, policy, reader)
	})

	it('publishes the same bytes and the same summary', async () => {
		const summary = await feed.generate()
		const generatedAt = new Date(summary.generated_at)
		// The reference reads the categories as the API did before D06.3: every one fully parsed.
		const former = await formerFeed(
			new FormerCategoryPublicReadService(mongoose.connection),
			generatedAt
		)
		const artifact = feed.getXml()!

		expect(former.items).toBeGreaterThan(500)
		expect(feedXmlOf(artifact)).toBe(former.xml)
		// Both kinds are on the fixture: grouped SKUs carry the product id, single ones do not.
		const items = former.xml.split('</item>').slice(0, -1)
		const grouped = items.filter(item => item.includes('<g:item_group_id>')).length
		expect(grouped).toBeGreaterThan(0)
		expect(grouped).toBeLessThan(items.length)
		expect(artifact.bytes).toBe(Buffer.byteLength(former.xml))
		expect(artifact.gzip.length).toBeLessThan(artifact.bytes / 5)
		expect(summary).toMatchObject({
			ok: true,
			item_count: former.items,
			in_stock: former.inStock,
			out_of_stock: former.outOfStock,
			typed_by_landing: former.typedByLanding,
			warned_items: former.warnedItems,
			excluded: former.excluded,
			excluded_count: former.excluded.length
		})
		const byReason: Record<string, number> = {}
		for (const row of former.excluded) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1
		expect(summary.excluded_by_reason).toEqual(byReason)
		expect(
			new Map(
				summary.warnings.map(w => [
					w.code,
					[w.item_count, w.skus, w.unit === 'category' ? w.count : 0]
				])
			)
		).toEqual(
			new Map(
				[...former.warnings].map(([code, [items, skus, cats]]) => [
					code,
					[items, skus, code === 'no_google_product_category' ? cats : 0]
				])
			)
		)
		// The mix really exercises what it claims to.
		// A SKU of a missing or hidden category is not listed at all under the public projection.
		expect(Object.keys(byReason).sort()).toEqual([
			'dangling_product',
			'missing_brand',
			'no_images',
			'no_price'
		])
		expect(former.typedByLanding).toBeGreaterThan(0)
		expect(former.xml).toContain('<g:sale_price_effective_date>')
		expect(former.xml).toContain('<g:custom_label_4>bestseller</g:custom_label_4>')
		expect(former.xml).toContain('<g:custom_label_4>popular</g:custom_label_4>')
		expect(former.xml).toContain('АВР &gt; АВР 63 А')
		expect(former.xml).toContain('<g:size>63 А</g:size>')
		expect(former.xml).toContain('<g:brand>Тепло</g:brand>')
		expect(former.xml).not.toContain('Прихований товар')
	})

	it('serves those bytes over HTTP with the former headers', async () => {
		const module = await Test.createTestingModule({
			controllers: [FeedController],
			providers: [
				{ provide: FeedService, useValue: feed },
				{
					provide: getLoggerToken(FeedController.name),
					useValue: { info: jest.fn(), warn: jest.fn() }
				}
			]
		}).compile()
		const app: INestApplication = module.createNestApplication({ logger: false })
		await app.init()
		try {
			const expected = feedXmlOf(feed.getXml()!)
			const res = await request(app.getHttpServer() as never)
				.get('/feeds/google-shopping.xml')
				.buffer(true)
				.parse((response, done) => {
					const chunks: Buffer[] = []
					response.on('data', (chunk: Buffer) => chunks.push(chunk))
					response.on('end', () => done(null, Buffer.concat(chunks)))
				})
			expect(res.status).toBe(200)
			expect((res.body as Buffer).equals(Buffer.from(expected))).toBe(true)
			expect(res.headers).toMatchObject({
				'content-type': 'application/xml; charset=utf-8',
				'last-modified': feed.getXml()!.generatedAt.toUTCString(),
				'cache-control': 'public, max-age=300',
				'content-length': String(Buffer.byteLength(expected))
			})
			expect(res.headers['transfer-encoding']).toBeUndefined()
			expect(res.headers['content-encoding']).toBeUndefined()
		} finally {
			await app.close()
		}
	})
})
