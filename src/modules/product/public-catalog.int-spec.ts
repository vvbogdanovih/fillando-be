import { APP_INTERCEPTOR } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { PublicCatalogController } from './public-catalog.controller'
import mongoose, { mongo } from 'mongoose'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { CATEGORY_FACET_LIMIT, PublicCatalogService, STRIP_WALK } from './public-catalog.service'
import { PublicProductService } from './public-product.service'
const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
let service: PublicCatalogService
const definition = (key: string, type: 'number' | 'boolean' | 'string', extra = {}) => ({
	key,
	label: key,
	value_type: type,
	unit: null,
	is_required: false,
	multiple: false,
	filter_enabled: true,
	filter_type: type === 'number' ? 'range' : 'multi-select',
	visible_in_specs: true,
	order: 0,
	semantic: 'generic',
	options: [],
	...extra
})
beforeAll(async () => {
	await connectTestDb('public-catalog')
})
afterAll(async () => {
	await dropTestDb(mongoose)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	service = new PublicCatalogService(
		mongoose.connection,
		new CategoryPublicReadService(mongoose.connection)
	)
	await mongoose.connection
		.db!.collection('catalog_control')
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 5, epoch: 7 } as never)
	await mongoose.connection.collection('categories').insertMany([
		{ _id: id(1), name: 'Root', slug: 'root', kind: 'group' },
		{
			_id: id(2),
			name: 'AVR',
			slug: 'avr',
			parent_id: id(1),
			attribute_contract_version: 2,
			attribute_definitions: [
				definition('amps', 'number'),
				definition('automatic', 'boolean'),
				definition('label', 'string', { multiple: true })
			]
		},
		{
			_id: id(3),
			name: 'Blankets',
			slug: 'blankets',
			parent_id: id(1),
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{ _id: id(4), name: 'Hidden', slug: 'hidden', kind: 'group', status: 'draft' },
		{ _id: id(5), name: 'Hidden child', slug: 'hidden-child', parent_id: id(4) }
	])
	await mongoose.connection.collection('products').insertMany([
		{
			_id: id(10),
			name: 'AVR',
			category_id: id(2),
			attributes_v2: [
				{ k: 'automatic', v: false },
				{ k: 'label', v: 'black, white' },
				{ k: 'label', v: 'black, white' }
			],
			variant_axis: { key: 'amps' }
		},
		{
			_id: id(11),
			name: 'Other AVR',
			category_id: id(2),
			attributes_v2: [{ k: 'automatic', v: true }],
			variant_axis: { key: 'amps' }
		},
		{ _id: id(12), name: 'Blanket', category_id: id(3), attributes_v2: [], variant_axis: null },
		{ _id: id(13), name: 'Hidden', category_id: id(5), attributes_v2: [], variant_axis: null }
	])
	await mongoose.connection.collection('product_variants').insertMany(
		[
			[20, 10, 2, 16, 100, 5],
			[21, 10, 2, 32, 200, 0],
			[22, 11, 2, 63, 300, 8],
			[23, 12, 3, null, 400, 1],
			[24, 13, 5, null, 500, 1]
		].map(([n, p, c, value, price, stock]) => ({
			_id: id(n!),
			product_id: id(p!),
			category_id: id(c!),
			name: `SKU ${n}`,
			slug: `sku-${n}`,
			sku: `FL-${n}`,
			variant_value: value,
			price,
			stock,
			status: 'active',
			images: ['https://example.com/image.jpg'],
			vendor_product_sku: 'SECRET',
			prom_base_price: 1
		}))
	)
})
const query = (filters: unknown, category_id = String(id(2))) => ({
	category_id,
	filters: JSON.stringify(filters)
})
it('matches typed false/range on the same SKU and counts self-excluding facets', async () => {
	const result = await service.read(
		query({
			attributes: [
				{ key: 'automatic', values: [false] },
				{ key: 'amps', min: 30, max: 40 }
			]
		})
	)
	expect(result.items.map(row => String(row.id))).toEqual([String(id(21))])
	expect(result.total).toBe(1)
	// The slider's bounds are the category's (16–63), not the narrowed listing's (TD-0008 §4 F7).
	expect(result.facets.attributes.find(row => row.key === 'amps')).toMatchObject({
		min: 16,
		max: 63
	})
	// `true` exists in the scope but not under the amps range: listed with 0, never dropped
	// (TD-0008 — the filter list must not jump; the legacy catalogue does the same).
	expect(result.facets.attributes.find(row => row.key === 'automatic')?.values).toEqual([
		{ value: false, count: 1 },
		{ value: true, count: 0 }
	])
	// Without any filter there is no zero to keep: every value counts itself.
	const unfiltered = await service.read({ category_id: String(id(2)) })
	expect(
		unfiltered.facets.attributes
			.find(row => row.key === 'automatic')
			?.values.every(row => row.count > 0)
	).toBe(true)
})
it('does not cross-match sibling values or count duplicate entries twice', async () => {
	const result = await service.read(
		query({ attributes: [{ key: 'label', values: ['black, white'] }] })
	)
	expect(result.total).toBe(2)
	expect(result.facets.attributes.find(row => row.key === 'label')?.values).toEqual([
		{ value: 'black, white', count: 2 }
	])
	expect(
		(
			await service.read(
				query({
					attributes: [
						{ key: 'amps', min: 63 },
						{ key: 'automatic', values: [false] }
					]
				})
			)
		).total
	).toBe(0)
})
it('supports group/global scope and refuses local attributes outside their product category', async () => {
	expect((await service.read({ category_id: String(id(1)) })).total).toBe(4)
	expect((await service.read({})).total).toBe(4)
	await expect(
		service.read(query({ attributes: [{ key: 'amps', min: 16 }] }, String(id(1))))
	).rejects.toMatchObject({ status: 400 })
	await expect(service.read(query({ category_ids: [String(id(3))] }))).rejects.toMatchObject({
		status: 400
	})
	expect(
		(await service.read(query({ category_ids: [String(id(3))] }, String(id(1))))).total
	).toBe(1)
})
it('uses promotion prices for sorting/filtering and excludes the price dimension from its own bounds', async () => {
	await mongoose.connection
		.collection('product_variants')
		.updateOne(
			{ _id: id(22) },
			{ $set: { promo_percent: 50, promo_ends_at: new Date('2099-01-01') } }
		)
	const result = await service.read({
		...query({ price: { min: 140, max: 160 } }),
		sort: 'price_asc'
	})
	expect(result.items.map(row => String(row.id))).toEqual([String(id(22))])
	expect(result.items[0]).toMatchObject({ price: 300, sale_price: 150 })
	expect(result.facets.price).toEqual({ min: 100, max: 200 })
})
it('lists only SKUs on a live promotion with on_sale, in a category and the whole catalogue', async () => {
	const variants = mongoose.connection.collection('product_variants')
	// Live; ended; a percent that rounds to no saving (100 × 0.996 → 100) is no promotion.
	await variants.updateOne(
		{ _id: id(22) },
		{ $set: { promo_percent: 50, promo_ends_at: new Date('2099-01-01') } }
	)
	await variants.updateOne(
		{ _id: id(21) },
		{ $set: { promo_percent: 30, promo_ends_at: new Date('2000-01-01') } }
	)
	await variants.updateOne({ _id: id(20) }, { $set: { promo_percent: 0.4, promo_ends_at: null } })
	const inCategory = await service.read(query({ on_sale: true }))
	expect(inCategory.items.map(row => String(row.id))).toEqual([String(id(22))])
	expect(inCategory.items[0]).toMatchObject({ price: 300, sale_price: 150 })
	const whole = await service.read({ filters: JSON.stringify({ on_sale: true }) })
	expect(whole.items.map(row => String(row.id))).toEqual([String(id(22))])
	expect(whole.total).toBe(1)
	await expect(
		service.read({ filters: JSON.stringify({ on_sale: false }) })
	).rejects.toMatchObject({ status: 400 })
})
it('keeps the price and number bounds of the whole category under any filter (TD-0008 §4 F7)', async () => {
	await mongoose.connection
		.collection('product_variants')
		.updateOne(
			{ _id: id(22) },
			{ $set: { promo_percent: 50, promo_ends_at: new Date('2099-01-01') } }
		)
	// The legacy rule (`findCatalog`): active SKUs of the category, effective price — whatever
	// else is selected, so the slider does not jump after every click.
	const legacy = await mongoose.connection
		.collection<{ price: number; promo_percent?: number | null }>('product_variants')
		.find({ category_id: id(2), status: 'active' })
		.toArray()
	const prices = legacy.map(row =>
		row.promo_percent ? Math.floor(row.price * (1 - row.promo_percent / 100) + 0.5) : row.price
	)
	const bounds = { min: Math.min(...prices), max: Math.max(...prices) }
	for (const filters of [
		{},
		{ attributes: [{ key: 'automatic', values: [true] }] },
		{ attributes: [{ key: 'amps', min: 30, max: 40 }] },
		{ in_stock: true },
		{ price: { min: 140, max: 160 } }
	]) {
		const result = await service.read(query(filters))
		expect(result.facets.price).toEqual(bounds)
		expect(result.facets.attributes.find(row => row.key === 'amps')).toMatchObject({
			min: 16,
			max: 63
		})
	}
	// The counts stay those of the narrowed listing: only the bounds are the category's.
	const narrowed = await service.read(
		query({ attributes: [{ key: 'automatic', values: [true] }] })
	)
	expect(narrowed.total).toBe(1)
	expect(narrowed.facets.attributes.find(row => row.key === 'label')?.values).toEqual([
		{ value: 'black, white', count: 0 }
	])
})
it('paginates with a deterministic ID tie-breaker and never exposes private fields', async () => {
	await mongoose.connection
		.collection('product_variants')
		.updateMany({ category_id: id(2) }, { $set: { price: 100, stock: 1 } })
	const first = await service.read({ category_id: String(id(2)), sort: 'price_asc', limit: '1' })
	const second = await service.read({
		category_id: String(id(2)),
		sort: 'price_asc',
		limit: '1',
		page: '2'
	})
	expect(first.items[0].id).toBe(String(id(20)))
	expect(second.items[0].id).toBe(String(id(21)))
	expect(JSON.stringify(first)).not.toMatch(/SECRET|vendor_product_sku|prom_base_price/)
})
it('narrows to the SKUs of listed products (a curated collection), visible categories only', async () => {
	const listed = await service.read({
		filters: JSON.stringify({ product_ids: [String(id(10)), String(id(13))] })
	})
	// Product 13 sits in a hidden branch: never listed, whatever the collection says.
	expect(listed.items.map(row => String(row.id)).sort()).toEqual([String(id(20)), String(id(21))])
	expect(listed.total).toBe(2)
	// The admin's order of products wins over «newest» (in-stock SKUs still first).
	const ordered = await service.read({
		filters: JSON.stringify({ product_ids: [String(id(11)), String(id(10))] })
	})
	expect(ordered.items.map(row => String(row.id))).toEqual([id(22), id(20), id(21)].map(String))
	expect(JSON.stringify(ordered)).not.toMatch(/_listed/)
	await expect(
		service.read({ filters: JSON.stringify({ product_ids: ['not-an-id'] }) })
	).rejects.toMatchObject({ status: 400 })
})
it('answers a strip with one card per product, grouped under the same scope and filters', async () => {
	const variants = mongoose.connection.collection('product_variants')
	await mongoose.connection.collection('colors').insertMany([
		{ _id: id(90), name_en: 'Black', family: 'black', hex_stops: ['#111111'] },
		{ _id: id(91), name_en: 'White', family: 'white', hex_stops: ['#ffffff'] }
	] as never)
	await variants.updateOne({ _id: id(20) }, { $set: { color_id: id(90) } })
	await variants.updateOne({ _id: id(21) }, { $set: { color_id: id(91) } })
	const strip = await service.strip({})
	// The listing's order (in stock first, newest first), each product once, by its first SKU.
	expect(strip.items.map(row => String(row.id))).toEqual([id(23), id(22), id(20)].map(String))
	expect(strip).toMatchObject({ revision: 5 })
	expect(strip.items[2].group).toEqual({
		name: 'AVR',
		count: 2,
		in_stock: 1,
		on_sale: 0,
		// Of the SKUs that can be bought: the sold-out one (200) does not widen the range.
		price_min: 100,
		price_max: 100,
		colors_count: 2,
		// In-stock colour first; the sold-out one is marked, not hidden.
		colors: [
			{ family: 'black', hex_stops: ['#111111'], in_stock: true },
			{ family: 'white', hex_stops: ['#ffffff'], in_stock: false }
		]
	})
	expect(strip.items[0].group).toMatchObject({ name: 'Blanket', count: 1, colors_count: 0 })
	expect(JSON.stringify(strip)).not.toMatch(/SECRET|prom_base_price|"_in_stock"|"_price"/)
	expect((await service.strip({ limit: '2' })).items).toHaveLength(2)
	// A category scope and the admin's order of a curated list.
	expect(
		(await service.strip({ category_id: String(id(2)) })).items.map(row => String(row.id))
	).toEqual([id(22), id(20)].map(String))
	expect(
		(
			await service.strip({
				filters: JSON.stringify({ product_ids: [String(id(10)), String(id(11))] })
			})
		).items.map(row => String(row.id))
	).toEqual([id(20), id(22)].map(String))
	// The group is the filter's: only the SKU on sale, at its sale price, though it is sold out.
	await variants.updateOne(
		{ _id: id(21) },
		{ $set: { promo_percent: 50, promo_ends_at: new Date('2099-01-01') } }
	)
	const sale = await service.strip({ filters: JSON.stringify({ on_sale: true }) })
	expect(sale.items.map(row => String(row.id))).toEqual([String(id(21))])
	expect(sale.items[0].group).toMatchObject({
		count: 1,
		in_stock: 0,
		on_sale: 1,
		price_min: 100,
		price_max: 100,
		colors_count: 1
	})
	// Outside «Акції» the group is the whole product: one of its two SKUs is on sale.
	const whole = await service.strip({ category_id: String(id(2)) })
	expect(whole.items.find(row => row.product_id === String(id(10)))?.group).toMatchObject({
		count: 2,
		on_sale: 1
	})
	// A strip has no page or order of its own, and the listing's limits on what it has.
	for (const bad of [{ page: '2' }, { sort: 'price_asc' }, { limit: '25' }, { limit: '0' }])
		await expect(service.strip(bad)).rejects.toMatchObject({ status: 400 })
	await expect(service.strip({ category_id: String(id(4)) })).rejects.toMatchObject({
		status: 404
	})
})
it('walks past a product whose colours fill the first page of the listing', async () => {
	await mongoose.connection.collection('products').insertOne({
		_id: id(14),
		name: 'Many colours',
		category_id: id(3),
		attributes_v2: [],
		variant_axis: null
	})
	await mongoose.connection.collection('product_variants').insertMany(
		Array.from({ length: 120 }, (_, index) => ({
			_id: id(1000 + index),
			product_id: id(14),
			category_id: id(3),
			name: `Colour ${index}`,
			slug: `colour-${index}`,
			sku: `FL-${1000 + index}`,
			price: 500 + index,
			stock: 1,
			status: 'active',
			images: []
		}))
	)
	const strip = await service.strip({})
	expect(strip.items.map(row => String(row.id))).toEqual(
		[id(1119), id(23), id(22), id(20)].map(String)
	)
	expect(strip.items[0].group).toMatchObject({
		name: 'Many colours',
		count: 120,
		in_stock: 120,
		price_min: 500,
		price_max: 619
	})
})
it('stops after five steps of the listing: past 500 SKUs a strip is shorter than its limit', async () => {
	// Six products of 100 SKUs, all in stock and newer than the fixture's: the first 500 SKUs of
	// the listing are five of them.
	await mongoose.connection.collection('products').insertMany(
		Array.from({ length: 6 }, (_, product) => ({
			_id: id(30 + product),
			name: `Hundred ${product}`,
			category_id: id(2),
			attributes_v2: [{ k: 'automatic', v: true }],
			variant_axis: { key: 'amps' }
		}))
	)
	await mongoose.connection.collection('product_variants').insertMany(
		Array.from({ length: 600 }, (_, index) => ({
			_id: id(2000 + index),
			product_id: id(30 + Math.floor(index / 100)),
			category_id: id(2),
			name: `Hundred ${index}`,
			slug: `hundred-${index}`,
			sku: `FL-H${index}`,
			variant_value: index,
			price: 1000 + index,
			stock: 1,
			status: 'active',
			images: []
		}))
	)
	const newest = [35, 34, 33, 32, 31].map(n => String(id(n)))
	// The whole catalogue (the variant-only path) and the category (the product join) alike.
	for (const scope of [{}, { category_id: String(id(2)) }]) {
		const strip = await service.strip({ ...scope, limit: '24' })
		expect(strip.items.map(row => String(row.product_id))).toEqual(newest)
		expect(strip.items.map(row => row.group.count)).toEqual([100, 100, 100, 100, 100])
		// More products are listed: the strip is cut by its walk, not by the catalogue.
		expect((await service.read(scope)).total).toBeGreaterThan(600)
	}
	// One more step reaches the sixth product and, past the 600 SKUs, the fixture's own.
	const pages = STRIP_WALK.pages
	STRIP_WALK.pages = 7
	try {
		const strip = await service.strip({ limit: '24' })
		expect(strip.items.map(row => String(row.product_id))).toEqual([
			...newest,
			...[30, 12, 11, 10].map(n => String(id(n)))
		])
	} finally {
		STRIP_WALK.pages = pages
	}
})
it('lists in-stock SKUs first under every order, as the legacy listing does', async () => {
	// SKU 21 is sold out: by «newest» alone it would sit between 22 and 20.
	expect(
		(await service.read({ category_id: String(id(2)) })).items.map(row => String(row.id))
	).toEqual([id(22), id(20), id(21)].map(String))
	for (const sort of ['price_asc', 'price_desc']) {
		const result = await service.read({ category_id: String(id(2)), sort })
		expect(result.items.at(-1)?.id).toBe(String(id(21)))
	}
	const first = await service.read({ category_id: String(id(2)), sort: 'price_desc' })
	expect(first.items.map(row => String(row.id))).toEqual([id(22), id(20), id(21)].map(String))
	expect(JSON.stringify(first)).not.toMatch(/_out_of_stock/)
})
it('excludes drafts, archives, mismatched categories and hidden branches', async () => {
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: id(20) }, { $set: { status: 'draft' } })
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: id(21) }, { $set: { status: 'archived' } })
	await mongoose.connection
		.collection('product_variants')
		.updateOne({ _id: id(22) }, { $set: { category_id: id(3) } })
	expect((await service.read({})).total).toBe(1)
	await expect(service.read({ category_id: String(id(5)) })).rejects.toMatchObject({
		status: 404
	})
})
it('self-excludes stock and category filters from their own facet counts', async () => {
	const result = await service.read(
		query({ in_stock: true, category_ids: [String(id(2))] }, String(id(1)))
	)
	expect(result.total).toBe(2)
	expect(result.facets.in_stock).toEqual({ true: 2, false: 1 })
	expect(result.facets.categories.map(row => row.count)).toEqual([2, 1])
})
it.each([
	{ sort: 'evil' },
	{ page: '0' },
	{ limit: '101' },
	{ page: ['1', '2'] },
	{ filters: 'bad' },
	{ filters: '{}', extra: 'unknown' },
	query({ attributes: [{ key: 'automatic', values: ['false'] }] }),
	query({ attributes: [{ key: 'amps', min: 50, max: 10 }] }),
	query({ attributes: [{ key: 'amps', values: [16] }] }),
	query({ color_families: ['black'] })
])('rejects malformed queries rather than silently weakening filters: %j', async raw => {
	await expect(service.read(raw)).rejects.toMatchObject({ status: 400 })
})
it('returns an empty successful page only for an actually empty public scope', async () => {
	await mongoose.connection.collection('product_variants').deleteMany({})
	const result = await service.read({})
	expect(result).toMatchObject({
		total: 0,
		items: [],
		facets: { price: { min: null, max: null } }
	})
})
it('blocks maintenance', async () => {
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { phase: 'writing' } })
	await expect(service.read({})).rejects.toMatchObject({ status: 503 })
	await expect(service.strip({})).rejects.toMatchObject({
		status: 503,
		response: { details: { code: 'CATALOG_MAINTENANCE' } }
	})
})

it('serves the anonymous HTTP contract and rejects repeated parameters; maintenance has retry/no-store headers', async () => {
	const app = await createRbacApp({
		controllers: [PublicCatalogController],
		providers: [
			{ provide: PublicCatalogService, useValue: service },
			{ provide: PublicProductService, useValue: {} },
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor }
		]
	})
	try {
		const response = await send(app, 'get', '/products/catalog/v2')
		expect(response.status).toBe(200)
		expect(response.body).toMatchObject({ revision: 5, total: 4 })
		expect((await send(app, 'get', '/products/catalog/v2?page=1&page=2')).status).toBe(400)
		const strip = await send(app, 'get', '/products/catalog/v2/strip?limit=2')
		expect(strip.status).toBe(200)
		expect(strip.body).toMatchObject({ revision: 5, items: [{ group: { count: 1 } }, {}] })
		expect((await send(app, 'get', '/products/catalog/v2/strip?page=2')).status).toBe(400)
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $set: { phase: 'writing' } })
		const busy = await send(app, 'get', '/products/catalog/v2')
		expect(busy.status).toBe(503)
		expect(busy.headers).toMatchObject({ 'retry-after': '5', 'cache-control': 'no-store' })
		// The strip route itself, not only the listing it walks.
		const busyStrip = await send(app, 'get', '/products/catalog/v2/strip?limit=2')
		expect(busyStrip.status).toBe(503)
		expect(busyStrip.body).toMatchObject({ details: { code: 'CATALOG_MAINTENANCE' } })
		expect(busyStrip.headers).toMatchObject({
			'retry-after': '5',
			'cache-control': 'no-store'
		})
	} finally {
		await app.close()
	}
})
it('answers a strip on a database that was never migrated: no catalog_control, a flat v1 category', async () => {
	const db = mongoose.connection
	await db.dropDatabase()
	// As production stores the catalogue before the migration: no control document; no kind,
	// status, parent or contract version on the category; no typed fields on products and SKUs.
	await db.collection('categories').insertOne({
		_id: id(1),
		name: 'Legacy',
		slug: 'legacy',
		required_attributes: [
			{
				key: 'kind',
				label: 'Kind',
				filter_type: 'multi-select',
				is_required: true,
				unit: null
			}
		],
		image: null,
		order: 0,
		google_product_category: null
	})
	await db.collection('colors').insertMany(
		[
			['Black', 'black', '#111111'],
			['White', 'white', '#ffffff'],
			['Red', 'red', '#cc0000']
		].map(([name, family, hex], n) => ({
			_id: id(90 + n),
			name_uk: name,
			name_en: name,
			family,
			hex_stops: [hex],
			order: n
		}))
	)
	await db.collection('products').insertMany([
		{
			_id: id(10),
			name: 'Old product',
			category_id: id(1),
			attributes: [{ k: 'kind', l: 'Kind', v: 'A' }],
			variant_type: { key: 'kolir', label: 'Колір' }
		},
		{ _id: id(11), name: 'Other old product', category_id: id(1), attributes: [] }
	])
	await db.collection('product_variants').insertMany(
		(
			[
				[20, 10, 100, 5, 'Black', 0],
				[21, 10, 200, 0, 'White', 1],
				[22, 10, 300, 3, 'Red', 2],
				[23, 11, 400, 1, null, null]
			] as const
		).map(([n, product, price, stock, value, color]) => ({
			_id: id(n),
			product_id: id(product),
			category_id: id(1),
			name: value ? `Old product — ${value}` : 'Other old product',
			slug: `old-${n}`,
			sku: `FL-${n}`,
			price,
			stock,
			images: [`https://example.com/${n}.jpg`],
			v_value: value,
			status: 'active',
			color_id: color === null ? null : id(90 + color),
			color_family: value ? value.toLowerCase() : null,
			promo_percent: n === 22 ? 50 : null,
			promo_ends_at: null
		}))
	)
	const app = await createRbacApp({
		controllers: [PublicCatalogController],
		providers: [
			{
				provide: PublicCatalogService,
				useValue: new PublicCatalogService(db, new CategoryPublicReadService(db))
			},
			{ provide: PublicProductService, useValue: {} },
			{ provide: getConnectionToken(), useValue: db },
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor }
		]
	})
	try {
		type Answer = { status: number; body: { revision: number; items: unknown[] } }
		const strip: Answer = await send(app, 'get', '/products/catalog/v2/strip')
		expect(strip.status).toBe(200)
		// In stock first, newest first; each product once, by its first SKU.
		expect(strip.body).toMatchObject({
			revision: 0,
			items: [
				{
					id: String(id(23)),
					product_id: String(id(11)),
					color: null,
					group: { name: 'Other old product', count: 1, in_stock: 1, colors: [] }
				},
				{
					id: String(id(22)),
					product_id: String(id(10)),
					category_id: String(id(1)),
					price: 300,
					sale_price: 150,
					promo_percent: 50,
					// A v1 SKU has no typed values, axis or brand.
					attributes_v2: [],
					variant_value: null,
					brand_id: null,
					color: { name_en: 'Red', family: 'red', hex_stops: ['#cc0000'] },
					group: {
						name: 'Old product',
						count: 3,
						in_stock: 2,
						on_sale: 1,
						price_min: 100,
						price_max: 150,
						colors_count: 3,
						colors: [
							{ family: 'red', hex_stops: ['#cc0000'], in_stock: true },
							{ family: 'black', hex_stops: ['#111111'], in_stock: true },
							{ family: 'white', hex_stops: ['#ffffff'], in_stock: false }
						]
					}
				}
			]
		})
		expect(strip.body.items).toHaveLength(2)
		// The v1 category as the scope is the same strip — no 409 on this route — and its
		// «Акції» is the one SKU on sale.
		const scoped: Answer = await send(
			app,
			'get',
			`/products/catalog/v2/strip?category_id=${String(id(1))}`
		)
		expect(scoped.status).toBe(200)
		expect(scoped.body).toEqual(strip.body)
		const sale: Answer = await send(
			app,
			'get',
			`/products/catalog/v2/strip?filters=${encodeURIComponent('{"on_sale":true}')}`
		)
		expect(sale.body.items).toMatchObject([
			{ id: String(id(22)), group: { count: 1, on_sale: 1, price_min: 150, price_max: 150 } }
		])
		// A read never creates the control document: the catalogue is still the legacy one.
		expect(await db.collection('catalog_control').countDocuments()).toBe(0)
	} finally {
		await app.close()
	}
})
it('discards results when revision changes between category resolution and SKU aggregation', async () => {
	const reader = new CategoryPublicReadService(mongoose.connection)
	// The listing resolves its scope and the selected node from one tree read.
	jest.spyOn(reader, 'findVisibleTree').mockImplementationOnce(async () => {
		// This one-off implementation is used up before it runs: the call reaches the real read.
		const categories = await reader.findVisibleTree()
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { revision: 1, epoch: 1 } })
		return categories
	})
	const changed = new PublicCatalogService(mongoose.connection, reader)
	await expect(changed.read({})).rejects.toMatchObject({
		status: 503,
		response: { details: { code: 'CATALOG_READ_CHANGED' } }
	})
})
it('does not leak unrecognized fields nested in stored attributes', async () => {
	await mongoose.connection.collection('products').updateOne(
		{ _id: id(10) },
		{
			$set: {
				attributes_v2: [{ k: 'automatic', v: false, private_supplier_note: 'SECRET' }]
			}
		}
	)
	expect(JSON.stringify(await service.read({}))).not.toContain('SECRET')
})

/** Plan-0010 large-catalogue load: the group/global listing skips the product join. */
it('lists a group without the product join yet with the same items, product fields and guards', async () => {
	const group = await service.read({ category_id: String(id(1)) })
	// Items still carry their product's typed values, from the page-only lookup.
	expect(group.items.find(row => row.id === String(id(23)))).toMatchObject({
		attributes_v2: [],
		category_id: String(id(3))
	})
	expect(group.items.find(row => row.id === String(id(22)))).toMatchObject({
		attributes_v2: [
			{ k: 'automatic', v: true },
			{ k: 'amps', v: 63 }
		]
	})
	// A SKU without its product is dropped from counts and items, as on the joined path — once
	// the scope facts are re-read (a new service here; a running one after SCOPE_FACTS_MS).
	await mongoose.connection.collection('products').deleteOne({ _id: id(12) })
	expect((await service.read({ category_id: String(id(1)) })).total).toBe(group.total)
	const fresh = new PublicCatalogService(
		mongoose.connection,
		new CategoryPublicReadService(mongoose.connection)
	)
	const orphan = await fresh.read({ category_id: String(id(1)) })
	expect(orphan.total).toBe(group.total - 1)
	expect(orphan.facets.categories.map(row => row.id)).not.toContain(String(id(3)))
	const later = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
	try {
		expect((await service.read({ category_id: String(id(1)) })).total).toBe(group.total - 1)
	} finally {
		later.mockRestore()
	}
})

it('counts only the selected categories once the scope has too many to list', async () => {
	const many = Array.from({ length: CATEGORY_FACET_LIMIT }, (_, n) => ({
		_id: id(1000 + n),
		name: `Leaf ${n}`,
		slug: `leaf-${n}`,
		parent_id: id(1),
		attribute_contract_version: 2,
		attribute_definitions: []
	}))
	await mongoose.connection.collection('categories').insertMany(many)
	const all = await service.read({ category_id: String(id(1)) })
	expect(all.facets.categories).toEqual([])
	const selected = await service.read({
		category_id: String(id(1)),
		filters: JSON.stringify({ category_ids: [String(id(3))] })
	})
	expect(selected.facets.categories).toEqual([{ id: String(id(3)), label: 'Blankets', count: 1 }])
	// Below the limit every product category in scope is counted, as before.
	expect((await service.read({ category_id: String(id(3)) })).facets.categories).toHaveLength(1)
})

it('re-reads the category tree after any write, even one that bumps neither revision nor updatedAt', async () => {
	const reader = new CategoryPublicReadService(mongoose.connection)
	expect((await reader.findById(String(id(3)))).name).toBe('Blankets')
	// The same parsed objects while nothing changed.
	expect(await reader.findById(String(id(3)))).toBe(await reader.findById(String(id(3))))
	await mongoose.connection
		.collection('categories')
		.updateOne({ _id: id(3) }, { $set: { name: 'Ковдри' } })
	expect((await reader.findById(String(id(3)))).name).toBe('Ковдри')
})
