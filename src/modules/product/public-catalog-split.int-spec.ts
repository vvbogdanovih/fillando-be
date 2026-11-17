import mongoose, { mongo } from 'mongoose'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import * as listingPage from './catalog-listing-page'
import { PublicCatalogService, SPLIT_LISTING, STRIP_SWATCHES } from './public-catalog.service'

/**
 * Plan-0010 D06: the whole catalogue and groups are listed by `splitListing` — cached totals and
 * facets plus an index walk for the page. These specs pin it to the single `$facet` aggregation
 * it replaced (what the service still runs when the server reports no write mark) on a mixed
 * tree: v1 and v2 categories, nested and hidden groups, drifted and orphaned SKUs, drafts and
 * archives, promotions (open-ended, dated, expired, rounding to nothing), zero, negative and
 * missing stock and many equal prices.
 */
const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
let service: PublicCatalogService
const variants = () => mongoose.connection.collection('product_variants')
const single = async <T>(read: () => Promise<T>) => {
	const spy = jest.spyOn(listingPage, 'variantWriteMark').mockResolvedValue(null)
	try {
		return await read()
	} finally {
		spy.mockRestore()
	}
}
const withRatio = async <T>(ratio: number, read: () => Promise<T>) => {
	const before = SPLIT_LISTING.walkRatio
	SPLIT_LISTING.walkRatio = ratio
	try {
		return await read()
	} finally {
		SPLIT_LISTING.walkRatio = before
	}
}

beforeAll(async () => {
	await connectTestDb('public-catalog-split')
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
		.insertOne({ _id: 'catalog', phase: 'idle', revision: 3, epoch: 4 } as never)
	await mongoose.connection.collection('categories').insertMany([
		{ _id: id(1), name: 'Group', slug: 'group', kind: 'group' },
		{
			_id: id(2),
			name: 'Typed A',
			slug: 'typed-a',
			parent_id: id(1),
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{ _id: id(3), name: 'Inner group', slug: 'inner', kind: 'group', parent_id: id(1) },
		{
			_id: id(4),
			name: 'Typed B',
			slug: 'typed-b',
			parent_id: id(3),
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		// A legacy (v1) product category at the root.
		{ _id: id(5), name: 'Legacy', slug: 'legacy' },
		{ _id: id(6), name: 'Hidden', slug: 'hidden', kind: 'group', status: 'draft' },
		{
			_id: id(7),
			name: 'Hidden leaf',
			slug: 'hidden-leaf',
			parent_id: id(6),
			attribute_contract_version: 2,
			attribute_definitions: []
		}
	])
	const categories = [id(2), id(4), id(5), id(7)]
	const products = Array.from({ length: 24 }, (_, n) => ({
		_id: id(100 + n),
		name: `Product ${n}`,
		category_id: categories[n % 4],
		attributes_v2: n % 3 ? [{ k: 'note', v: `n${n}` }] : [],
		variant_axis: null
	}))
	await mongoose.connection.collection('products').insertMany(products)
	// 150 SKUs over a few price points (ties everywhere), stock 0/neg/missing on some.
	const prices = [100, 250, 250, 400, 599, 599, 599, 1000]
	const stocks: (number | null | undefined)[] = [5, 0, 12, 1, -1, 3, null, undefined, 7, 0]
	const rows = Array.from({ length: 150 }, (_, n) => {
		const product = products[n % products.length]
		const stock = stocks[n % stocks.length]
		return {
			_id: id(1000 + ((n * 37) % 150)),
			product_id: product._id,
			category_id: product.category_id,
			name: `SKU ${n}`,
			slug: `sku-${n}`,
			sku: `SP-${n}`,
			price: prices[(n * 7) % prices.length],
			...(stock === undefined ? {} : { stock }),
			status: n % 19 === 5 ? 'draft' : n % 23 === 7 ? 'archived' : 'active',
			images: [],
			vendor_product_sku: 'SECRET'
		}
	})
	const day = 24 * 3600 * 1000
	Object.assign(rows[3], { promo_percent: 20 })
	Object.assign(rows[9], { promo_percent: 50, promo_ends_at: new Date(Date.now() + day) })
	Object.assign(rows[11], { promo_percent: 30, promo_ends_at: new Date(Date.now() - day) })
	Object.assign(rows[17], { promo_percent: 10, price: 1 }) // rounds to no saving
	Object.assign(rows[21], { promo_percent: 40 }) // promoted, maybe sold out
	Object.assign(rows[33], { promo_percent: 75, promo_ends_at: new Date(Date.now() + 2 * day) })
	Object.assign(rows[40], { promo_percent: 10 })
	// Drift: a SKU outside its product's category, and an orphan.
	// (product 2 sits in the legacy category id(5))
	Object.assign(rows[50], { category_id: id(4) })
	Object.assign(rows[60], { product_id: id(999) })
	await variants().insertMany(rows)
	await variants().createIndex({ status: 1, promo_percent: 1, price: 1 })
})

const queries = () => {
	const out: Record<string, string>[] = []
	const filterSets = [
		{},
		{ in_stock: true },
		{ in_stock: false },
		{ price: { min: 200, max: 600 } },
		{ price: { min: 300 } },
		{ price: { max: 250 } },
		{ price: {} }
	]
	for (const category_id of [undefined, String(id(1)), String(id(3))])
		for (const filters of [
			...filterSets,
			...(category_id === String(id(3))
				? []
				: [
						{ category_ids: [String(id(2))] },
						{ category_ids: [String(id(2))], in_stock: true }
					])
		])
			for (const sort of ['newest', 'price_asc', 'price_desc'])
				for (const [limit, pages] of [
					[7, [1, 2, 5, 9, 11, 12, 17, 30]],
					[24, [1, 2, 3, 4, 6]]
				] as const)
					for (const page of pages)
						out.push({
							...(category_id ? { category_id } : {}),
							filters: JSON.stringify(filters),
							sort,
							limit: String(limit),
							page: String(page)
						})
	return out
}

it('returns exactly what the single aggregation returns — walked, sorted and beyond the last page', async () => {
	const all = queries()
	expect(all.length).toBeGreaterThan(900)
	let nonEmpty = 0
	for (const query of all) {
		const expected = await single(() => service.read(query))
		const forced = await withRatio(0, () => service.read(query))
		const chosen = await service.read(query)
		expect({ query, result: forced }).toEqual({ query, result: expected })
		expect({ query, result: chosen }).toEqual({ query, result: expected })
		if (expected.items.length) nonEmpty++
	}
	expect(nonEmpty).toBeGreaterThan(300)
	// The fixture really exercises what it claims.
	const whole = await service.read({ limit: '100', page: '1' })
	expect(whole.total).toBeGreaterThan(80)
	expect(JSON.stringify(whole)).not.toMatch(/SECRET|_out_of_stock|"_price"|"_out"/)
}, 300_000)

it('serves a write acknowledged before the read, never totals cached from before it', async () => {
	const query = { sort: 'price_asc', limit: '5' }
	await withRatio(0, () => service.read(query))
	const cheapest = (await single(() => service.read(query))).items[0]
	// Raw writes (as the Prom sync and the CLI do): price, stock, status, a new SKU.
	await variants().updateOne({ _id: id(1000 + 1) }, { $set: { price: 5, stock: 9 } })
	await variants().updateMany({ price: 599 }, { $set: { stock: 0 } })
	await variants().updateOne({ slug: 'sku-0' }, { $set: { status: 'archived' } })
	await variants().insertOne({
		_id: id(5000),
		product_id: id(100),
		category_id: id(2),
		name: 'Fresh',
		slug: 'fresh',
		sku: 'SP-FRESH',
		price: 2,
		stock: 1,
		status: 'active',
		images: []
	})
	for (const sort of ['newest', 'price_asc', 'price_desc'])
		for (const page of ['1', '3']) {
			const read = { ...query, sort, page }
			const fresh = await withRatio(0, () => service.read(read))
			expect(fresh).toEqual(await single(() => service.read(read)))
		}
	const after = await withRatio(0, () => service.read(query))
	expect(after.items[0]).toMatchObject({ id: String(id(5000)), price: 2 })
	expect(after.items[0]).not.toEqual(cheapest)
})

it('drops cached totals when a promotion in scope ends, without any write', async () => {
	// The dearest SKU while its promotion lasts: 5 000 at −50 %.
	await variants().updateOne(
		{ slug: 'sku-9' },
		{ $set: { price: 5000, stock: 50, promo_ends_at: new Date(Date.now() + 1500) } }
	)
	const query = { sort: 'price_desc', limit: '5' }
	const during = await withRatio(0, () => service.read(query))
	expect(during.items[0]).toMatchObject({ slug: 'sku-9', sale_price: 2500 })
	expect(during.facets.price.max).toBe(2500)
	await new Promise(resolve => setTimeout(resolve, 1700))
	const after = await withRatio(0, () => service.read(query))
	expect(after).toEqual(await single(() => service.read(query)))
	expect(after.facets.price.max).toBe(5000)
	expect(after.items[0]).toMatchObject({ slug: 'sku-9', sale_price: null })
})

it('shares one totals computation between concurrent reads and reuses it until a write', async () => {
	const collection = mongoose.connection.collection('product_variants')
	const spy = jest.spyOn(collection, 'aggregate')
	const totals = () =>
		spy.mock.calls.filter(([pipeline]) => JSON.stringify(pipeline).includes('"promo_ends"'))
			.length
	try {
		await withRatio(0, () =>
			Promise.all(['1', '2', '3', '4'].map(page => service.read({ page, limit: '5' })))
		)
		expect(totals()).toBe(1)
		await service.read({ page: '5', limit: '5', sort: 'price_desc' })
		expect(totals()).toBe(1)
		await variants().updateOne({ slug: 'sku-1' }, { $inc: { stock: 1 } })
		await service.read({ limit: '5' })
		expect(totals()).toBe(2)
	} finally {
		spy.mockRestore()
	}
})

it('sorts the scope instead when the price index is missing, and walks many promotions exactly', async () => {
	await variants().dropIndex('status_1_promo_percent_1_price_1')
	for (const sort of ['price_asc', 'price_desc']) {
		const query = { sort, limit: '7', page: '2' }
		expect(await withRatio(0, () => service.read(query))).toEqual(
			await single(() => service.read(query))
		)
	}
	await variants().createIndex({ status: 1, promo_percent: 1, price: 1 })
	const many = Array.from({ length: 1500 }, (_, n) => ({
		_id: id(20000 + n),
		product_id: id(100),
		category_id: id(2),
		name: `Promo ${n}`,
		slug: `promo-${n}`,
		sku: `SP-P${n}`,
		price: 100 + (n % 50),
		stock: n % 4,
		promo_percent: 10,
		status: 'active',
		images: []
	}))
	await variants().insertMany(many)
	for (const sort of ['price_asc', 'price_desc'])
		for (const filters of ['{}', '{"price":{"min":120,"max":140}}', '{"in_stock":false}'])
			for (const page of ['1', '3', '40', '70']) {
				const query = { sort, filters, limit: '24', page }
				expect({ query, result: await withRatio(0, () => service.read(query)) }).toEqual({
					query,
					result: await single(() => service.read(query))
				})
			}
}, 120_000)

/**
 * `GET /products/catalog/v2/strip` on the same mixed tree, with colours on four SKUs of five and a
 * colour axis plus a filterable characteristic on «Typed A» — so its strip takes the joined path
 * while the whole catalogue, the groups and the v1 category take the variant-only one.
 */
describe('product strip — one card per product', () => {
	const A = String(id(2))
	const colours = (
		[
			['Black', 'black', '#111111'],
			['White', 'white', '#ffffff'],
			['Red', 'red', '#cc0000'],
			['Blue', 'blue', '#0000cc']
		] as const
	).map(([name, family, hex], n) => ({
		_id: id(900 + n),
		name_uk: name,
		name_en: name,
		family,
		hex_stops: [hex],
		order: n
	}))
	const definition = (key: string, extra = {}) => ({
		key,
		label: key,
		value_type: 'string',
		unit: null,
		is_required: false,
		multiple: false,
		filter_enabled: true,
		filter_type: 'multi-select',
		visible_in_specs: true,
		order: 0,
		semantic: 'generic',
		options: [],
		...extra
	})
	const fresh = () =>
		new PublicCatalogService(
			mongoose.connection,
			new CategoryPublicReadService(mongoose.connection)
		)
	beforeEach(async () => {
		await mongoose.connection.collection('colors').insertMany(colours)
		await variants().bulkWrite(
			Array.from({ length: 150 }, (_, k) => k)
				.filter(k => k % 5)
				.map(k => ({
					updateOne: {
						filter: { _id: id(1000 + k) },
						update: {
							$set: {
								color_id: colours[k % 4]._id,
								color_family: colours[k % 4].family
							}
						}
					}
				}))
		)
		await mongoose.connection.collection('categories').updateOne(
			{ _id: id(2) },
			{
				$set: {
					attribute_definitions: [
						definition('note'),
						definition('color', {
							semantic: 'color',
							is_required: true,
							filter_enabled: false,
							filter_type: null,
							order: 1
						})
					]
				}
			}
		)
	})

	type Scope = { category_id?: string; filters: Record<string, unknown> }
	/** What the reference reads of a listing item. */
	type Row = mongo.Document & {
		product_id: string
		stock?: number | null
		price: number
		sale_price: number | null
		color: { name_en: string; family: string; hex_stops: string[] } | null
	}
	const queryOf = ({ category_id, filters }: Scope) => ({
		...(category_id ? { category_id } : {}),
		filters: JSON.stringify(filters)
	})
	/**
	 * What a strip must answer, from the public listing alone (CATEGORY_TREE.md, «Product strip»):
	 * the «newest» listing under the same scope and filters, each product once by its first SKU
	 * there, and its group counted over that product's SKUs in the same listing.
	 */
	const fromListing = async (scope: Scope) => {
		const rows: Row[] = []
		for (let page = 1, total = Infinity; rows.length < total; page++) {
			const listing = await service.read({
				...queryOf(scope),
				limit: '100',
				page: String(page)
			})
			if (!listing.items.length) break
			rows.push(...(listing.items as Row[]))
			total = listing.total
		}
		const names = new Map(
			(await mongoose.connection.collection('products').find().toArray()).map(product => [
				String(product._id),
				product.name as string
			])
		)
		const groups = new Map<string, Row[]>()
		for (const row of rows)
			groups.set(row.product_id, [...(groups.get(row.product_id) ?? []), row])
		const buyable = (sku: Row) => (sku.stock ?? 0) > 0
		return [...groups].map(([productId, skus]) => {
			const inStock = skus.filter(buyable)
			const paid = (inStock.length ? inStock : skus).map(sku => sku.sale_price ?? sku.price)
			const swatches = new Map<
				string,
				{ family: string; hex_stops: string[]; in_stock: boolean }
			>()
			for (const sku of skus)
				if (sku.color && !swatches.has(sku.color.name_en))
					swatches.set(sku.color.name_en, {
						family: sku.color.family,
						hex_stops: sku.color.hex_stops,
						in_stock: buyable(sku)
					})
			return {
				...skus[0],
				group: {
					name: names.get(productId),
					count: skus.length,
					in_stock: inStock.length,
					on_sale: skus.filter(sku => sku.sale_price !== null).length,
					price_min: Math.min(...paid),
					price_max: Math.max(...paid),
					colors_count: swatches.size,
					colors: [...swatches.values()].slice(0, STRIP_SWATCHES)
				}
			}
		})
	}

	it('answers the public listing grouped by product on every path — index walk, sorted page, no write mark, product join', async () => {
		const scopes: Scope[] = []
		for (const category_id of [undefined, String(id(1)), String(id(3)), String(id(5)), A])
			for (const filters of [
				{},
				{ in_stock: true },
				{ in_stock: false },
				{ price: { min: 200, max: 600 } },
				{ on_sale: true },
				...(category_id === undefined || category_id === String(id(1))
					? [
							{ category_ids: [A] },
							// A hand-picked list in its own order; product 103 sits in the hidden branch.
							{ product_ids: [113, 101, 104, 103, 120, 100].map(n => String(id(n))) }
						]
					: []),
				...(category_id === A
					? [
							{ attributes: [{ key: 'note', values: ['n4', 'n8', 'n16'] }] },
							{ color_families: ['black', 'red'] }
						]
					: [])
			])
				scopes.push({ ...(category_id ? { category_id } : {}), filters })
		const seen = { cards: 0, several: 0, sale: 0, soldOut: 0, faded: 0, shared: 0, range: 0 }
		for (const scope of scopes) {
			const expected = await fromListing(scope)
			for (const card of expected) {
				seen.cards++
				if (card.group.count > 1) seen.several++
				if (card.group.on_sale) seen.sale++
				if (!card.group.in_stock) seen.soldOut++
				if (card.group.colors.some(color => !color.in_stock)) seen.faded++
				if (card.group.colors_count && card.group.colors_count < card.group.count)
					seen.shared++
				if (card.group.price_min < card.group.price_max) seen.range++
			}
			for (const limit of [24, 5, 1]) {
				const query = { ...queryOf(scope), limit: String(limit) }
				const want = { scope, limit, items: expected.slice(0, limit) }
				for (const strip of [
					await service.strip(query),
					await withRatio(0, () => service.strip(query)),
					await single(() => service.strip(query))
				])
					expect({ scope, limit, items: strip.items }).toEqual(want)
			}
		}
		// The fixture really exercises what it claims: groups of several SKUs, sales, sold-out
		// products, sold-out colours, two SKUs of one colour and a price range.
		expect(scopes).toHaveLength(31)
		expect(seen.cards).toBeGreaterThan(200)
		for (const [what, count] of Object.entries(seen))
			expect({ what, count }).not.toEqual({ what, count: 0 })
		// The hand-picked list never shows the product of the hidden branch.
		const picked = await service.strip({
			filters: JSON.stringify({
				product_ids: [113, 101, 104, 103, 120, 100].map(n => String(id(n)))
			})
		})
		expect(picked.items.map(card => String(card.product_id)).sort()).toEqual(
			[100, 101, 104, 113, 120].map(n => String(id(n)))
		)
	}, 120_000)

	it('walks without a $facet stage: a step reads its page as a plain pipeline on every path', async () => {
		const spies = ['product_variants', 'products'].map(name =>
			jest.spyOn(mongoose.connection.collection(name), 'aggregate')
		)
		const sent = () =>
			spies.flatMap(spy =>
				spy.mock.calls.map(([pipeline, options]) => ({
					pipeline: JSON.stringify(pipeline),
					hint: (options as { hint?: unknown } | undefined)?.hint
				}))
			)
		const sale = JSON.stringify({ on_sale: true })
		const list = JSON.stringify({ product_ids: [String(id(104)), String(id(101))] })
		const paths: [string, () => Promise<unknown>][] = [
			['index walk', () => withRatio(0, () => fresh().strip({ limit: '24' }))],
			['sorted page', () => withRatio(1e9, () => fresh().strip({ limit: '24' }))],
			['no write mark', () => single(() => fresh().strip({ limit: '24' }))],
			['group on sale', () => fresh().strip({ category_id: String(id(1)), filters: sale })],
			['product join', () => fresh().strip({ category_id: A, limit: '24' })],
			['product list', () => fresh().strip({ filters: list })]
		]
		try {
			for (const [path, run] of paths) {
				spies.forEach(spy => spy.mockClear())
				await run()
				const pipelines = sent()
				// Something was read (the page and the groups at least) and none of it is a `$facet`.
				expect({ path, read: pipelines.length >= 2 }).toEqual({ path, read: true })
				expect({
					path,
					facets: pipelines.filter(row => row.pipeline.includes('$facet'))
				}).toEqual({ path, facets: [] })
				// On the product join a step is one pipeline — the page — beside the groups: no
				// second pass over the join to count a total nobody reads.
				if (path === 'product join') expect(pipelines).toHaveLength(2)
				// The first path really is the walk of the `_id` index.
				if (path === 'index walk')
					expect(pipelines.some(row => JSON.stringify(row.hint) === '{"_id":1}')).toBe(
						true
					)
			}
			// The public listing still is one `$facet` — on both of its paths — so the check above
			// would have seen a facet computed for a strip.
			for (const query of [{}, { category_id: A }]) {
				spies.forEach(spy => spy.mockClear())
				await fresh().read(query)
				expect(sent().filter(row => row.pipeline.includes('$facet'))).toHaveLength(1)
			}
		} finally {
			spies.forEach(spy => spy.mockRestore())
		}
	})
})

describe('category counts for navigation (Plan-0010 D06.5)', () => {
	type Facets = { facets: { categories: { id: string; count: number }[] } }
	it('equal the whole-catalogue category facet (drift, orphans, hidden branches, drafts)', async () => {
		const facet = ((await service.read({ limit: '1' })) as unknown as Facets).facets.categories
		const counts = await service.categoryCounts({})
		expect(counts.revision).toBe(3)
		expect(counts.next_cursor).toBeNull()
		expect(counts.categories).toEqual(facet.map(({ id, count }) => ({ id, count })))
		expect(counts.categories.length).toBeGreaterThan(1)
		// The same through the single aggregation (no write mark on the server).
		const aggregated = (await single(() => service.read({ limit: '1' }))) as unknown as Facets
		expect(aggregated.facets.categories.map(({ id, count }) => ({ id, count }))).toEqual(
			counts.categories
		)
	})
	it('count every category past the facet limit, page by id, and restart after a SKU write', async () => {
		const many = Array.from({ length: 130 }, (_, n) => ({
			_id: id(5000 + n),
			name: `Leaf ${n}`,
			slug: `leaf-${n}`,
			parent_id: id(1),
			attribute_contract_version: 2,
			attribute_definitions: []
		}))
		await mongoose.connection.collection('categories').insertMany(many)
		await mongoose.connection.collection('products').insertMany(
			many.map((category, n) => ({
				_id: id(7000 + n),
				name: `P${n}`,
				category_id: category._id,
				attributes_v2: [],
				variant_axis: null
			}))
		)
		await variants().insertMany(
			many.map((category, n) => ({
				_id: id(9000 + n),
				product_id: id(7000 + n),
				category_id: category._id,
				name: `S${n}`,
				slug: `many-${n}`,
				sku: `MANY-${n}`,
				price: 100,
				stock: 1,
				status: 'active',
				images: []
			}))
		)
		// The listing's own facet stops at 100 product categories; the counts do not.
		const facet = ((await service.read({ limit: '1' })) as unknown as Facets).facets.categories
		expect(facet).toEqual([])
		const all = await service.categoryCounts({})
		expect(all.categories.length).toBeGreaterThan(130)
		const pages: { id: string; count: number }[] = []
		let cursor: string | undefined
		do {
			const page = await service.categoryCounts({ limit: '50', cursor })
			pages.push(...page.categories)
			cursor = page.next_cursor ?? undefined
		} while (cursor)
		expect(pages).toEqual(all.categories)
		const first = await service.categoryCounts({ limit: '50' })
		await variants().updateOne({ _id: id(9000) }, { $set: { status: 'draft' } })
		await expect(
			service.categoryCounts({ limit: '50', cursor: first.next_cursor! })
		).rejects.toMatchObject({ status: 409 })
		expect(
			(await service.categoryCounts({})).categories.find(row => row.id === String(id(5000)))
		).toBeUndefined()
		// The listing's own rule: a plain positive integer, nothing `Number()` would also accept.
		for (const limit of ['0', '0x2', '1e3', ' 5', '5.0', '20001', ['1', '2']])
			await expect(service.categoryCounts({ limit })).rejects.toMatchObject({ status: 400 })
		await expect(service.categoryCounts({ cursor: 'garbage' })).rejects.toMatchObject({
			status: 400
		})
	})
})
