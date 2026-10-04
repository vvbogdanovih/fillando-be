import { Model, Types } from 'mongoose'
import { ProductStatus } from 'src/common/types/enums'
import {
	effectivePriceExpr,
	effectivePriceOf,
	publicPromoFields,
	publicPromoProjection
} from 'src/modules/product/promo-pricing'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * TD-0012 — the promotion rule lives twice: as JavaScript (`activePromo`) for documents already in
 * memory and as an aggregation expression for the catalogue pipeline. This suite is what keeps
 * them one rule: every fixture goes through both and the answers must match, and the catalogue's
 * filter, sort, slider bounds and facet narrowing must all read the sale price while a promo is on.
 *
 * Fixture (one category, one product each):
 *
 * | variant | price | promo_percent | promo_ends_at | expected sale |
 * |---------|-------|---------------|---------------|---------------|
 * | none    |  500  | —             | —             | —             |
 * | open    |  600  | 10            | null          | 540           |
 * | future  |  700  | 15            | +1 year       | 595           |
 * | expired |  800  | 50            | −1 day        | — (expired)   |
 * | zero    |    0  | 50            | null          | — (no price)  |
 * | max     | 1000  | 90            | +1 year       | 100           |
 * | half    |  250  | 15            | null          | 213 (212.5 rounds up on both sides) |
 * | nosale  |   40  | 1             | null          | — (rounds back to 40: not a sale) |
 * | tiny    |    3  | 90            | null          | — (rounds to 0: nothing is sold for nothing) |
 * | edge    |  700  | 10            | = NOW         | — (ends exactly now: already over)   |
 *
 * `edge` is judged by the fixed `NOW` in the parity test but by `$$NOW` in the catalogue tests, so
 * its price is chosen to land between `future` and `expired` whether its promo is on (630) or off.
 * | legacy  |  300  | (no promo fields at all) | — (written before TD-0012) | —   |
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

/** The catalogue item fields this suite reads. */
type CatalogRow = {
	sku: string
	price: number
	sale_price: number | null
	promo_percent: number | null
	promo_ends_at: Date | null
}
const rowsOf = (result: { items: unknown[] }) => result.items as CatalogRow[]

describe('promo pricing — JS rule and aggregation twin agree (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository
	let variantModel: Model<ProductVariant>

	const NOW = new Date('2026-10-04T12:00:00.000Z')
	// Far enough ahead that the `$$NOW`-based catalogue assertions do not expire with the calendar.
	const YEAR_AHEAD = new Date('2099-10-04T12:00:00.000Z')
	const YESTERDAY = new Date('2026-10-03T12:00:00.000Z')
	const categoryId = new Types.ObjectId()

	const seed = [
		{ key: 'none', price: 500, promo_percent: null, promo_ends_at: null },
		{ key: 'open', price: 600, promo_percent: 10, promo_ends_at: null },
		{ key: 'future', price: 700, promo_percent: 15, promo_ends_at: YEAR_AHEAD },
		{ key: 'expired', price: 800, promo_percent: 50, promo_ends_at: YESTERDAY },
		{ key: 'zero', price: 0, promo_percent: 50, promo_ends_at: null },
		{ key: 'max', price: 1000, promo_percent: 90, promo_ends_at: YEAR_AHEAD },
		{ key: 'half', price: 250, promo_percent: 15, promo_ends_at: null },
		{ key: 'nosale', price: 40, promo_percent: 1, promo_ends_at: null },
		{ key: 'tiny', price: 3, promo_percent: 90, promo_ends_at: null },
		{ key: 'edge', price: 700, promo_percent: 10, promo_ends_at: NOW }
	]
	/** A document written before the promo fields existed: no keys at all, not nulls. */
	const legacy = { key: 'legacy', price: 300 }

	beforeAll(async () => {
		conn = await connectTestDb('variant-promo')
		const categoryModel = conn.model(Category.name, CategorySchema)
		const productModel = conn.model(Product.name, ProductSchema)
		variantModel = conn.model<ProductVariant>(ProductVariant.name, ProductVariantSchema)
		await Promise.all([categoryModel.init(), productModel.init(), variantModel.init()])

		await categoryModel.create({
			_id: categoryId,
			name: 'Філамент',
			slug: 'filament',
			required_attributes: [
				{
					key: 'polymer',
					label: 'Тип пластику',
					filter_type: 'multi-select',
					is_required: true,
					unit: null
				}
			]
		})
		for (const row of seed) {
			const productId = new Types.ObjectId()
			await productModel.create({
				_id: productId,
				name: `P-${row.key}`,
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }]
			})
			await variantModel.create({
				product_id: productId,
				category_id: categoryId,
				name: `V-${row.key}`,
				slug: `v-${row.key}`,
				sku: `SKU-${row.key}`,
				price: row.price,
				stock: 5,
				images: [],
				status: ProductStatus.ACTIVE,
				promo_percent: row.promo_percent,
				promo_ends_at: row.promo_ends_at
			})
		}
		// Straight into the collection so Mongoose cannot fill in the `null` defaults.
		const legacyProduct = new Types.ObjectId()
		await productModel.create({
			_id: legacyProduct,
			name: 'P-legacy',
			category_id: categoryId,
			vendor_id: new Types.ObjectId(),
			attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }]
		})
		await variantModel.collection.insertOne({
			product_id: legacyProduct,
			category_id: categoryId,
			name: 'V-legacy',
			slug: 'v-legacy',
			sku: 'SKU-legacy',
			price: legacy.price,
			stock: 5,
			images: [],
			status: ProductStatus.ACTIVE
		})
		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	it('derives the same sale price, percent, end date and effective price on both sides', async () => {
		const rows = await variantModel
			.aggregate<{
				sku: string
				price: number
				promo_percent: number | null
				promo_ends_at: Date | null
				sale_price: number | null
				effective: number
			}>([
				{
					$project: {
						sku: 1,
						price: 1,
						raw_percent: '$promo_percent',
						raw_ends_at: '$promo_ends_at',
						...publicPromoProjection(NOW),
						effective: effectivePriceExpr(NOW)
					}
				}
			])
			.exec()
		expect(rows).toHaveLength(seed.length + 1)

		// The legacy row has neither key: both sides must still answer the full trio, as nulls.
		const legacyRow = rows.find(r => r.sku === 'SKU-legacy')!
		expect(legacyRow).toMatchObject({
			sale_price: null,
			promo_percent: null,
			promo_ends_at: null
		})
		expect(Object.keys(legacyRow)).toEqual(
			expect.arrayContaining(['sale_price', 'promo_percent', 'promo_ends_at'])
		)
		expect(publicPromoFields(legacy, NOW)).toEqual({
			sale_price: null,
			promo_percent: null,
			promo_ends_at: null
		})

		for (const fixture of seed) {
			const mongo = rows.find(r => r.sku === `SKU-${fixture.key}`)!
			const js = publicPromoFields(fixture, NOW)
			expect({ ...mongo, key: fixture.key }).toMatchObject({
				key: fixture.key,
				sale_price: js.sale_price,
				promo_percent: js.promo_percent,
				promo_ends_at: js.promo_ends_at,
				effective: effectivePriceOf(fixture, NOW)
			})
			// Same key set on both sides, whatever the state — the public row shape never varies.
			expect(Object.keys(mongo)).toEqual(
				expect.arrayContaining(['sale_price', 'promo_percent', 'promo_ends_at'])
			)
		}
		expect(rows.find(r => r.sku === 'SKU-tiny')).toMatchObject({
			sale_price: null,
			effective: 3
		})
		expect(rows.find(r => r.sku === 'SKU-edge')).toMatchObject({
			sale_price: null,
			effective: 700
		})
	})

	it('nulls the public trio for an expired promo and for a variant without a price', async () => {
		const items = await repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 20,
			sort: 'newest',
			attrFilters: {}
		})
		const bySku = new Map(rowsOf(items).map(i => [i.sku, i]))
		expect(bySku.get('SKU-expired')).toMatchObject({
			price: 800,
			sale_price: null,
			promo_percent: null,
			promo_ends_at: null
		})
		expect(bySku.get('SKU-zero')).toMatchObject({ sale_price: null, promo_percent: null })
		expect(bySku.get('SKU-nosale')).toMatchObject({
			price: 40,
			sale_price: null,
			promo_percent: null
		})
		expect(bySku.get('SKU-half')).toMatchObject({
			price: 250,
			sale_price: 213,
			promo_percent: 15
		})
		expect(bySku.get('SKU-open')).toMatchObject({
			price: 600,
			sale_price: 540,
			promo_percent: 10
		})
	})

	it('sorts by what the shopper pays, not by the regular price', async () => {
		const result = await repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 20,
			sort: 'price_asc',
			attrFilters: {}
		})
		// Effective: zero 0, tiny 3, nosale 40, max 100, half 213, legacy 300, none 500, open 540,
		// future 595, edge 630 or 700 (see the fixture table), expired 800.
		expect(rowsOf(result).map(i => i.sku)).toEqual([
			'SKU-zero',
			'SKU-tiny',
			'SKU-nosale',
			'SKU-max',
			'SKU-half',
			'SKU-legacy',
			'SKU-none',
			'SKU-open',
			'SKU-future',
			'SKU-edge',
			'SKU-expired'
		])
	})

	it('filters the price range against the effective price', async () => {
		const result = await repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 20,
			price_min: 530,
			price_max: 600,
			sort: 'newest',
			attrFilters: {}
		})
		// `open` (600 → 540) and `future` (700 → 595) are in; `none` (500) and `expired` (800) are out.
		expect(
			rowsOf(result)
				.map(i => i.sku)
				.sort()
		).toEqual(['SKU-future', 'SKU-open'])
	})

	it('bounds the slider by the effective prices of the whole category', async () => {
		const result = await repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 20,
			sort: 'newest',
			attrFilters: {}
		})
		expect(result.price_range).toEqual({ min: 0, max: 800 })
	})

	it('narrows the facet counts by the effective price too', async () => {
		const result = await repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 20,
			price_min: 530,
			price_max: 600,
			sort: 'newest',
			attrFilters: {},
			facetKeys: ['polymer']
		})
		expect(result.facets.polymer).toEqual([{ value: 'PLA', count: 2 }])
	})

	it('counts the promotions that ended inside a window — what the expiry cron asks', async () => {
		expect(
			await repo.countPromosEndedBetween(
				new Date('2026-10-03T00:00:00.000Z'),
				new Date('2026-10-04T00:00:00.000Z')
			)
		).toBe(1)
		// `edge` ends at 12:00 on the 4th.
		expect(
			await repo.countPromosEndedBetween(
				new Date('2026-10-04T00:00:00.000Z'),
				new Date('2026-10-05T00:00:00.000Z')
			)
		).toBe(1)
		expect(
			await repo.countPromosEndedBetween(
				new Date('2026-10-05T00:00:00.000Z'),
				new Date('2026-10-06T00:00:00.000Z')
			)
		).toBe(0)
	})

	it('writes one promotion to every variant of a product and clears it the same way', async () => {
		const [open] = await variantModel.find({ sku: 'SKU-open' }).lean().exec()
		const productId = String(open.product_id)

		const applied = await repo.setPromoByProductId(productId, {
			promo_percent: 25,
			promo_ends_at: YEAR_AHEAD
		})
		expect(applied).toEqual({ matched: 1, modified: 1 })
		expect(await variantModel.findOne({ sku: 'SKU-open' }).lean().exec()).toMatchObject({
			promo_percent: 25,
			promo_ends_at: YEAR_AHEAD
		})

		const cleared = await repo.setPromoByProductId(productId, {
			promo_percent: null,
			promo_ends_at: null
		})
		expect(cleared).toEqual({ matched: 1, modified: 1 })
		expect(await variantModel.findOne({ sku: 'SKU-open' }).lean().exec()).toMatchObject({
			promo_percent: null,
			promo_ends_at: null
		})
	})
})
