import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, PipelineStage, Types } from 'mongoose'
import { ProductVariant } from '../schemas/product-variant.schema'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { BaseRepository } from './base.repository'
import {
	PRICE_SHEET_PUBLIC_PROJECTION,
	toPublicVariant
} from 'src/modules/product/product-public.mappers'
import type { Color } from '../schemas/color.schema'
import type { PriceListRawRow } from 'src/modules/product/price-list/price-list.types'
import { mergeFacetValues, type CatalogFacetValue } from 'src/common/utils/facet.utils'

/**
 * One swatch in the catalogue colour filter: what to paint, and how many variants of the current
 * narrowing carry it — counted without the colour filter itself, like every other facet.
 */
export interface CatalogColorOption {
	family: string
	count: number
	hex_stops: string[]
}

/**
 * The spooled version of a refill, for the price reference on its page. `matched_colour` says
 * whether it is the same colour — when it is not, the figure is a "from", not this filament's
 * price on a spool.
 */
export interface SpooledCounterpart {
	slug: string
	name: string
	price: number
	matched_colour: boolean
}

/** The dictionary fields the public colour payload is built from. */
type PublicColorSource = Pick<Color, 'name_uk' | 'name_en' | 'family' | 'hex_stops'>

/** One ACTIVE variant as `findActiveForFeed` returns it — the Google Shopping feed's working set. */
export interface FeedVariantRow {
	id: string
	product_id: string
	sku: string
	name: string
	slug: string
	price: number
	stock: number
	images: string[]
	v_value: string | null
	weight_g: number | null
	product: {
		name: string
		description_html: string | null
		attributes: { k?: string; l?: string; v?: string | number | boolean }[]
		variant_type: { key?: string; label?: string } | null
	} | null
	category: {
		id: string
		name: string
		google_product_category: { id: number; path: string } | null
		required_attributes: { key: string; label: string }[]
	} | null
	color: { name_uk: string; name_en: string } | null
}

@Injectable()
export class ProductVariantRepository extends BaseRepository<ProductVariant> {
	constructor(@InjectModel(ProductVariant.name) model: Model<ProductVariant>) {
		super(model)
	}

	findBySlug(slug: string): Promise<HydratedDocument<ProductVariant> | null> {
		return this.findOne({ slug })
	}

	findBySku(sku: string): Promise<HydratedDocument<ProductVariant> | null> {
		return this.findOne({ sku })
	}

	/**
	 * Every variant already occupying one of these slugs. Renaming a product regenerates the
	 * slug of each of its variants, and `slug` is unique — this is the pre-flight that turns a
	 * collision into a 409 naming the SKUs instead of a duplicate-key error halfway through the
	 * batch.
	 */
	findBySlugs(slugs: string[]): Promise<ProductVariant[]> {
		return this.findAll({ slug: { $in: slugs } })
	}

	findByProductId(productId: string): Promise<ProductVariant[]> {
		return this.findAll({ product_id: new Types.ObjectId(productId) })
	}

	findByIds(ids: Types.ObjectId[]): Promise<ProductVariant[]> {
		return this.findAll({ _id: { $in: ids } })
	}

	/**
	 * Rewrites the denormalized `color_family` on every variant of one dictionary colour.
	 *
	 * This deployment runs a standalone MongoDB, so the colour update and this backfill cannot
	 * share a transaction (TD-0002 §5.2.2 assumed one). The service therefore writes the
	 * dictionary first and calls this second: `Color.family` stays the source of truth, and a
	 * failure here leaves variants recomputable from it — re-issuing the same PATCH repairs them.
	 *
	 * @returns how many variants were changed
	 */
	async updateColorFamilyByColorId(colorId: string, family: ColorFamily): Promise<number> {
		const result = await this.model
			.updateMany(
				{ color_id: new Types.ObjectId(colorId), color_family: { $ne: family } },
				{ $set: { color_family: family } }
			)
			.exec()
		return result.modifiedCount
	}

	/** Variants still pointing at a colour — a dictionary entry may not be deleted under them. */
	countByColorId(colorId: string): Promise<number> {
		return this.model.countDocuments({ color_id: new Types.ObjectId(colorId) }).exec()
	}

	/**
	 * How many variants point at each dictionary colour, keyed by colour id.
	 *
	 * One grouped pass instead of a `countDocuments` per colour: the dictionary holds ~100
	 * entries and the admin list needs every count at once.
	 *
	 * Counts variants in **every** status on purpose, so the number agrees with
	 * {@link countByColorId} — the guard that refuses the delete. A column reading 0 next to a
	 * 409 "still used by 4 variants" would be worse than no column at all.
	 */
	async countAllByColorId(): Promise<Map<string, number>> {
		const rows = await this.model
			.aggregate<{
				_id: Types.ObjectId
				count: number
			}>([
				{ $match: { color_id: { $ne: null } } },
				{ $group: { _id: '$color_id', count: { $sum: 1 } } }
			])
			.exec()
		return new Map(rows.map(row => [String(row._id), row.count]))
	}

	/**
	 * How many catalogue variants each landing's pinned filters match — the admin's «Товарів»
	 * column, and the check that refuses to publish a landing matching nothing.
	 *
	 * Counted exactly the way the landing page is filled: ACTIVE variants of the landing's
	 * category whose product carries every pinned attribute — one `$elemMatch` per key, AND
	 * across keys, OR within one — which is what {@link findCatalogItems} does for the same
	 * input. A pinned `color_family` is matched on the variant instead, exactly as
	 * `ProductService.getCatalog` routes it: colour is denormalized onto the variant and never
	 * stored in `product.attributes`, so an `$elemMatch` there would answer 0 for a landing the
	 * storefront fills correctly — and the guard below would refuse to publish it (I-g).
	 *
	 * The landing's `price_min`/`price_max` are deliberately ignored: the storefront builds the
	 * landing's catalogue query from `filters` alone, so applying them here would make the
	 * column disagree with the page it describes.
	 *
	 * One `$facet` over a single joined pass rather than a query per landing — every branch
	 * reads the same piped input, so fourteen landings cost one scan instead of fourteen.
	 */
	async countVariantsForLandings(
		landings: Array<{
			id: string
			category_id: Types.ObjectId
			filters: Record<string, string[]>
		}>
	): Promise<Map<string, number>> {
		if (landings.length === 0) return new Map()

		const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {}
		for (const landing of landings) {
			const conditions: Record<string, unknown>[] = [{ category_id: landing.category_id }]
			for (const [key, values] of Object.entries(landing.filters ?? {})) {
				if (values.length === 0) continue
				if (key === COLOR_FAMILY_FILTER_KEY) {
					conditions.push({ color_family: { $in: values } })
					continue
				}
				conditions.push({
					'product.attributes': { $elemMatch: { k: key, v: { $in: values } } }
				})
			}
			facet[facetKey(landing.id)] = [{ $match: { $and: conditions } }, { $count: 'n' }]
		}

		const [row] = await this.model
			.aggregate<Record<string, Array<{ n: number }>>>([
				{ $match: { status: ProductStatus.ACTIVE } },
				{
					$lookup: {
						from: 'products',
						localField: 'product_id',
						foreignField: '_id',
						as: 'product',
						// Only the attributes are matched on — no point hauling descriptions.
						pipeline: [{ $project: { _id: 0, attributes: 1 } }]
					}
				},
				{ $unwind: '$product' },
				{ $facet: facet }
			])
			.exec()

		return new Map(
			landings.map(landing => [landing.id, row?.[facetKey(landing.id)]?.[0]?.n ?? 0])
		)
	}

	/** Variants whose denormalized family disagrees with the dictionary, per colour. */
	async countColorFamilyDrift(): Promise<number> {
		const [row] = await this.model
			.aggregate<{ n: number }>([
				{ $match: { color_id: { $ne: null } } },
				{
					$lookup: {
						from: 'colors',
						localField: 'color_id',
						foreignField: '_id',
						as: 'color'
					}
				},
				{ $unwind: '$color' },
				{ $match: { $expr: { $ne: ['$color_family', '$color.family'] } } },
				{ $count: 'n' }
			])
			.exec()
		return row?.n ?? 0
	}

	async updateCategoryByProductId(productId: string, categoryId: string): Promise<void> {
		await this.model
			.updateMany(
				{ product_id: new Types.ObjectId(productId) },
				{ $set: { category_id: new Types.ObjectId(categoryId) } }
			)
			.exec()
	}

	findAllWithPromId(): Promise<ProductVariant[]> {
		return this.findAll({ prom_id: { $exists: true, $nin: [null, ''] } })
	}

	/** Public (sitemap). Only ACTIVE variants have a public page, so only they get a URL. */
	findAllSlugs(): Promise<Array<{ slug: string; updatedAt: Date }>> {
		return this.model
			.find({ status: ProductStatus.ACTIVE }, { slug: 1, updatedAt: 1, _id: 0 })
			.lean<Array<{ slug: string; updatedAt: Date }>>()
			.exec()
	}

	/**
	 * Public. The storefront uses this count as the cache key for the sitemap built from
	 * {@link findAllSlugs}, so it has to count the same set — ACTIVE only — or archiving a
	 * variant would never invalidate the sitemap.
	 */
	async countAll(): Promise<number> {
		return this.model.countDocuments({ status: ProductStatus.ACTIVE }).exec()
	}

	/**
	 * Public product page. ACTIVE and ARCHIVED variants are found — an archived one renders as
	 * «Знято з продажу» so a live ad or backlink does not land on a 404 (TD-0006 §5.4). DRAFT
	 * stays invisible on purpose. Siblings and the spooled counterpart remain ACTIVE-only, and
	 * the `variant` part goes through {@link toPublicVariant} so supplier fields never leak.
	 */
	async findVariantWithProduct(slug: string) {
		const variant = await this.model
			.findOne({ slug, status: { $in: [ProductStatus.ACTIVE, ProductStatus.ARCHIVED] } })
			.lean()
			.exec()
		if (!variant) return null

		const [product, siblings, category] = await Promise.all([
			this.model.db.collection('products').findOne(
				{ _id: variant.product_id },
				{
					projection: {
						name: 1,
						description: 1,
						attributes: 1,
						variant_type: 1,
						spooled_product_id: 1
					}
				}
			),
			this.model
				.find(
					{ product_id: variant.product_id, status: ProductStatus.ACTIVE },
					{
						_id: 1,
						name: 1,
						slug: 1,
						sku: 1,
						price: 1,
						v_value: 1,
						images: 1,
						stock: 1,
						price_updated_at: 1,
						status: 1,
						color_id: 1
					}
				)
				.lean()
				.exec(),
			this.model.db
				.collection('categories')
				.findOne({ _id: variant.category_id }, { projection: { slug: 1, name: 1 } })
		])

		if (!product) return null

		// One query for every colour on the page: the variant and its siblings usually differ
		// only by colour, so this is a handful of ids and saves a lookup per sibling.
		const colorIds = [variant, ...siblings]
			.map(v => v.color_id)
			.filter((id): id is Types.ObjectId => Boolean(id))
		const colorsById = await this.loadColorsById(colorIds)

		const spooledCounterpart = await this.findSpooledCounterpart(
			(product as any).spooled_product_id,
			variant.color_id
		)

		return {
			variant: toPublicVariant(variant, colorsById.get(String(variant.color_id))),
			product: {
				id: String((product as any)._id),
				name: (product as any).name,
				description: (product as any).description,
				attributes: (product as any).attributes,
				variant_type: (product as any).variant_type
			},
			// Same public allowlist as `variant` — one projection for the whole public page.
			siblings: siblings.map(s => toPublicVariant(s, colorsById.get(String(s.color_id)))),
			category_slug: (category as any)?.slug ?? null,
			category_name: (category as any)?.name ?? null,
			spooled_counterpart: spooledCounterpart
		}
	}

	/**
	 * The spooled version of a refill, for the price reference and the link on its page.
	 *
	 * Same colour where there is one — a refill in Natural should quote the Natural spool, not
	 * whichever variant happens to sort first — and the cheapest ACTIVE variant otherwise, since
	 * the page shows the figure as "from". `null` for every ordinary product: only a refill
	 * carries `spooled_product_id`.
	 */
	private async findSpooledCounterpart(
		spooledProductId: Types.ObjectId | null | undefined,
		colorId: Types.ObjectId | null | undefined
	): Promise<SpooledCounterpart | null> {
		if (!spooledProductId) return null

		const projection = { _id: 0, slug: 1, name: 1, price: 1 }
		const sameColour = colorId
			? await this.model
					.findOne(
						{
							product_id: spooledProductId,
							color_id: colorId,
							status: ProductStatus.ACTIVE
						},
						projection
					)
					.lean<{ slug: string; name: string; price: number }>()
					.exec()
			: null
		if (sameColour) return { ...sameColour, matched_colour: true }

		// A refill whose own colour has no spool left is not the same offer, so this is the
		// cheapest one — the page words it as "from" rather than as the price of this filament.
		const cheapest = await this.model
			.findOne({ product_id: spooledProductId, status: ProductStatus.ACTIVE }, projection)
			.sort({ price: 1 })
			.lean<{ slug: string; name: string; price: number }>()
			.exec()
		return cheapest ? { ...cheapest, matched_colour: false } : null
	}

	/** Dictionary rows for the given colour ids, keyed by id string. */
	private async loadColorsById(
		ids: Types.ObjectId[]
	): Promise<Map<string, PublicColorSource | undefined>> {
		const unique = [...new Map(ids.map(id => [String(id), id])).values()]
		if (unique.length === 0) return new Map()

		const rows = await this.model.db
			.collection('colors')
			.find(
				{ _id: { $in: unique } },
				{ projection: { name_uk: 1, name_en: 1, family: 1, hex_stops: 1 } }
			)
			.toArray()
		return new Map(rows.map(row => [String(row._id), row as unknown as PublicColorSource]))
	}

	async findBySkuPrefix(prefix: string): Promise<Array<{ _id: Types.ObjectId }>> {
		const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		return this.model
			.find(
				{ sku: { $regex: `^${escaped}`, $options: 'i' }, status: ProductStatus.ACTIVE },
				{ _id: 1 }
			)
			.limit(100)
			.lean<Array<{ _id: Types.ObjectId }>>()
			.exec()
	}

	async findSearchResults(params: {
		productIds: Types.ObjectId[]
		skuVariantIds: Types.ObjectId[]
		page: number
		limit: number
	}) {
		const { productIds, skuVariantIds, page, limit } = params
		const skip = (page - 1) * limit

		const matchConditions: any[] = []
		if (productIds.length > 0) {
			matchConditions.push({ product_id: { $in: productIds }, status: ProductStatus.ACTIVE })
		}
		if (skuVariantIds.length > 0) {
			matchConditions.push({ _id: { $in: skuVariantIds } })
		}

		if (matchConditions.length === 0) {
			return {
				items: [],
				pagination: { total: 0, page, limit, totalPages: 0 }
			}
		}

		const pipeline: any[] = [
			{ $match: { $or: matchConditions } },
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{
				$addFields: {
					_isSkuMatch: {
						$cond: [{ $in: ['$_id', skuVariantIds] }, 0, 1]
					},
					_outOfStock: { $cond: [{ $gt: ['$stock', 0] }, 0, 1] }
				}
			},
			{ $sort: { _isSkuMatch: 1, _outOfStock: 1, score: -1 } as Record<string, 1 | -1> },
			{
				$facet: {
					items: [
						{ $skip: skip },
						{ $limit: limit },
						{
							$project: {
								_id: 0,
								id: { $toString: '$_id' },
								name: 1,
								slug: 1,
								sku: 1,
								price: 1,
								stock: 1,
								price_updated_at: 1,
								v_value: 1,
								attributes: '$product.attributes',
								main_image: { $ifNull: [{ $arrayElemAt: ['$images', 0] }, null] }
							}
						}
					],
					meta: [{ $count: 'total' }]
				}
			}
		]

		const [result] = await this.model.aggregate(pipeline).exec()
		const items = result?.items ?? []
		const total = result?.meta[0]?.total ?? 0

		return {
			items,
			pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }
		}
	}

	/**
	 * Public price sheet. ACTIVE variants only; the search term is matched against public
	 * fields only (never `vendor_product_sku` — that would be an oracle for supplier SKUs)
	 * and rows are shaped by {@link PRICE_SHEET_PUBLIC_PROJECTION}.
	 */
	async findPriceSheet(params: { q?: string; page: number; limit: number }) {
		const { q, page, limit } = params
		const skip = (page - 1) * limit

		const pipeline: any[] = [
			{ $match: { status: ProductStatus.ACTIVE } },
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			// Left join: variants without a dictionary colour keep a null here and the service
			// falls back to the attribute-derived name.
			{
				$lookup: {
					from: 'colors',
					localField: 'color_id',
					foreignField: '_id',
					as: 'color'
				}
			},
			{ $unwind: { path: '$color', preserveNullAndEmptyArrays: true } }
		]

		const term = (q ?? '').trim()
		if (term.length > 0) {
			const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			const rx = { $regex: escaped, $options: 'i' }
			pipeline.push({
				$match: {
					$or: [{ 'product.name': rx }, { sku: rx }, { 'product.attributes.v': rx }]
				}
			})
		}

		pipeline.push(
			{ $addFields: { _hasStock: { $cond: [{ $gt: ['$stock', 0] }, 1, 0] } } },
			// Availability first (in-stock variants before out-of-stock), then within each
			// availability bucket group a product's variants together (by product name, then
			// product id) so they don't scatter when variants were added at different times.
			{
				$sort: {
					_hasStock: -1,
					'product.name': 1,
					product_id: 1,
					name: 1
				} as Record<string, 1 | -1>
			},
			{
				$facet: {
					items: [
						{ $skip: skip },
						{ $limit: limit },
						{ $project: PRICE_SHEET_PUBLIC_PROJECTION }
					],
					meta: [{ $count: 'total' }]
				}
			}
		)

		const [result] = await this.model.aggregate(pipeline).exec()
		return {
			items: result?.items ?? [],
			total: result?.meta?.[0]?.total ?? 0
		}
	}

	/**
	 * Unpaginated variant rows for the admin price list PDF. Mongo does the cheap,
	 * index-friendly work (filter + a deterministic pre-sort); the fuzzy brand lookup and
	 * the uk-UA alphabetical ordering happen in JS, where the same regex patterns as the
	 * price sheet apply and `Intl.Collator` sorts Cyrillic correctly.
	 */
	findPriceListRows(params: {
		categoryIds?: string[]
		inStockOnly?: boolean
		limit: number
	}): Promise<PriceListRawRow[]> {
		const { categoryIds, inStockOnly, limit } = params

		const match: Record<string, unknown> = { status: ProductStatus.ACTIVE }
		if (categoryIds && categoryIds.length > 0) {
			match.category_id = { $in: categoryIds.map(id => new Types.ObjectId(id)) }
		}
		if (inStockOnly) match.stock = { $gt: 0 }

		return this.model
			.aggregate<PriceListRawRow>([
				{ $match: match },
				{
					$lookup: {
						from: 'products',
						localField: 'product_id',
						foreignField: '_id',
						as: 'product',
						// Only what the price list needs — avoids hauling every description.
						pipeline: [
							{ $project: { _id: 0, name: 1, attributes: 1, variant_type: 1 } }
						]
					}
				},
				{ $unwind: '$product' },
				{
					$project: {
						_id: 0,
						product_id: { $toString: '$product_id' },
						product_name: '$product.name',
						attributes: '$product.attributes',
						variant_type: '$product.variant_type',
						variant_name: '$name',
						v_value: 1,
						sku: 1,
						price: 1,
						stock: 1
					}
				},
				{ $sort: { product_name: 1, variant_name: 1, sku: 1 } },
				{ $limit: limit }
			])
			.allowDiskUse(true)
			.exec()
	}

	/**
	 * Working set of the Google Shopping feed (TD-0006 §5.3): every ACTIVE variant with the
	 * product, category and dictionary colour joined in. Not a hot path — an hourly job and the
	 * admin button — so the three `$lookup`s are fine here and the catalogue keeps its
	 * "no new joins" rule. `preserveNullAndEmptyArrays` keeps a variant whose product or category
	 * is gone in the result as `null`, so the builder can report it instead of dropping it silently.
	 *
	 * PUBLIC SURFACE by way of the feed: the projection lists fields explicitly and carries no
	 * supplier identifier or `prom_*` value — the int-spec pins that.
	 */
	findActiveForFeed(): Promise<FeedVariantRow[]> {
		return this.model
			.aggregate<FeedVariantRow>([
				{ $match: { status: ProductStatus.ACTIVE } },
				{
					$lookup: {
						from: 'products',
						localField: 'product_id',
						foreignField: '_id',
						as: 'product',
						pipeline: [
							{
								$project: {
									_id: 0,
									name: 1,
									description_html: { $ifNull: ['$description.html', null] },
									attributes: { $ifNull: ['$attributes', []] },
									variant_type: { $ifNull: ['$variant_type', null] }
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
									google_product_category: {
										$ifNull: ['$google_product_category', null]
									},
									required_attributes: { $ifNull: ['$required_attributes', []] }
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
						stock: { $ifNull: ['$stock', 0] },
						images: { $ifNull: ['$images', []] },
						v_value: { $ifNull: ['$v_value', null] },
						weight_g: { $ifNull: ['$weight_g', null] },
						product: { $ifNull: ['$product', null] },
						category: { $ifNull: ['$category', null] },
						color: { $ifNull: ['$color', null] }
					}
				},
				{ $sort: { sku: 1 } }
			])
			.allowDiskUse(true)
			.exec()
	}

	async findCatalogItems(params: {
		category_id: string
		page: number
		limit: number
		price_min?: number
		price_max?: number
		sort: string
		attrFilters: Record<string, string[]>
		colorFamilies?: string[]
		/** The category's `required_attributes` keys — the dimensions to count facets for. */
		facetKeys?: string[]
	}) {
		const {
			category_id,
			page,
			limit,
			price_min,
			price_max,
			sort,
			attrFilters,
			colorFamilies = [],
			facetKeys = []
		} = params
		const skip = (page - 1) * limit

		const variantMatch: Record<string, any> = {
			category_id: new Types.ObjectId(category_id),
			status: ProductStatus.ACTIVE
		}
		// Matched on the variant itself, before the product join, so the index
		// { category_id, status, color_family } can serve it.
		if (colorFamilies.length > 0) {
			variantMatch.color_family = { $in: colorFamilies }
		}
		const priceMatch: { $gte?: number; $lte?: number } = {}
		if (price_min !== undefined) priceMatch.$gte = price_min
		if (price_max !== undefined) priceMatch.$lte = price_max
		if (price_min !== undefined || price_max !== undefined) {
			variantMatch.price = priceMatch
		}

		const pipeline: any[] = [
			{ $match: variantMatch },
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{
				$lookup: {
					from: 'colors',
					localField: 'color_id',
					foreignField: '_id',
					as: 'color'
				}
			},
			{ $unwind: { path: '$color', preserveNullAndEmptyArrays: true } }
		]

		const attrConditions: any[] = []
		for (const [key, values] of Object.entries(attrFilters)) {
			if (values.length > 0) {
				attrConditions.push({
					'product.attributes': { $elemMatch: { k: key, v: { $in: values } } }
				})
			}
		}
		if (attrConditions.length > 0) {
			pipeline.push({ $match: { $and: attrConditions } })
		}

		const userSort: Record<string, 1 | -1> =
			sort === 'price_asc'
				? { price: 1 }
				: sort === 'price_desc'
					? { price: -1 }
					: { _id: -1 }

		pipeline.push(
			{ $addFields: { _outOfStock: { $cond: [{ $gt: ['$stock', 0] }, 0, 1] } } },
			{ $sort: { _outOfStock: 1, ...userSort } as Record<string, 1 | -1> },
			{
				$facet: {
					items: [
						{ $skip: skip },
						{ $limit: limit },
						{
							$project: {
								_id: 0,
								id: { $toString: '$_id' },
								name: 1,
								slug: 1,
								sku: 1,
								price: 1,
								stock: 1,
								price_updated_at: 1,
								v_value: 1,
								attributes: '$product.attributes',
								main_image: { $ifNull: [{ $arrayElemAt: ['$images', 0] }, null] },
								// Same four fields as PublicColor; null for variants with no
								// dictionary colour, so the card falls back to `v_value`.
								color: {
									$cond: [
										{ $ifNull: ['$color', false] },
										{
											name_uk: '$color.name_uk',
											name_en: '$color.name_en',
											family: '$color.family',
											hex_stops: '$color.hex_stops'
										},
										null
									]
								}
							}
						}
					],
					meta: [{ $count: 'total' }]
				}
			}
		)

		const categoryObjectId = new Types.ObjectId(category_id)

		// Over the whole category on purpose: these are the slider's bounds, and bounds that
		// jump after every click make the control unusable (TD-0008 §4 F7).
		const priceRangePipeline: any[] = [
			{ $match: { category_id: categoryObjectId, status: ProductStatus.ACTIVE } },
			{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }
		]

		/**
		 * Everything the shopper has narrowed by, minus one dimension (TD-0008 §5.4.1). The
		 * number next to «PETG» while «PLA» is ticked is "how many variants carry PETG under
		 * every other filter" — so the dimension's own filter is left out and the list never
		 * collapses to the one value just chosen; price, colour and the other attributes still
		 * apply. (Within a dimension the filter is an OR, so the numbers are per value, not what
		 * the total would become after the click.) Built from the same inputs as the listing, so
		 * the two can never disagree about what is active.
		 */
		const narrowingMatch = (exclude: string | typeof COLOR_DIMENSION): Record<string, any> => {
			const match: Record<string, any> = {}
			if (price_min !== undefined || price_max !== undefined) match.price = priceMatch
			if (exclude !== COLOR_DIMENSION && colorFamilies.length > 0) {
				match.color_family = { $in: colorFamilies }
			}
			const conditions: any[] = []
			for (const [key, values] of Object.entries(attrFilters)) {
				if (key !== exclude && values.length > 0) {
					conditions.push({ attributes: { $elemMatch: { k: key, v: { $in: values } } } })
				}
			}
			if (conditions.length > 0) match.$and = conditions
			return match
		}

		/**
		 * One `$facet` for every sidebar number. Branch names are positional (`count_0`,
		 * `count_1`, …) rather than the attribute key, so a key can never be an invalid field
		 * name here; the position maps back to `facetKeys` below.
		 *
		 * Counting is per variant, not per attribute entry: a product may carry the same
		 * `finish` twice, and the `$unwind` would otherwise count that variant twice.
		 */
		const facetBranches: Record<string, any[]> = {
			// Every value of every dimension, over the whole category — the list itself. A
			// value with no match in the current narrowing stays, with a zero count.
			values: [
				{ $unwind: '$attributes' },
				{ $match: { 'attributes.k': { $in: facetKeys } } },
				{ $group: { _id: { k: '$attributes.k', v: { $toString: '$attributes.v' } } } },
				// A required attribute saved blank in the admin form is stored as `v: ''`, and
				// that is not a value of the dimension — the sidebar would draw a checkbox with
				// no name next to a count (I-4). `$toString` has already turned a legal `0` or
				// `false` into '0'/'false', which `\S` keeps; only a value that is whitespace
				// and nothing else — or absent, hence null — fails it.
				{ $match: { '_id.v': { $regex: /\S/ } } }
			],
			// Colour families present in the category, each with every dictionary colour that
			// could paint its swatch. Which one does is decided by {@link pickFamilySwatch},
			// not by the order documents happen to reach `$group`: the swatch is the emblem of
			// the FAMILY, so it may not change shape because the dictionary was re-sorted or
			// Mongo answered in another order (I-21). `$addToSet` bounds the branch by the
			// dictionary — one entry per distinct colour used in the category, not per variant.
			color_all: [
				{ $match: { color_id: { $ne: null } } },
				{
					$lookup: {
						from: 'colors',
						localField: 'color_id',
						foreignField: '_id',
						as: 'color'
					}
				},
				{ $unwind: '$color' },
				{
					$group: {
						_id: '$color.family',
						candidates: {
							$addToSet: {
								order: { $ifNull: ['$color.order', 0] },
								name_en: { $ifNull: ['$color.name_en', ''] },
								hex_stops: { $ifNull: ['$color.hex_stops', []] }
							}
						}
					}
				}
			],
			// Same `color_id` gate as `color_all`, so a variant whose denormalised family has
			// drifted from the dictionary cannot surface as a family of its own.
			color_count: [
				{ $match: { ...narrowingMatch(COLOR_DIMENSION), color_id: { $ne: null } } },
				{ $group: { _id: '$color_family', count: { $sum: 1 } } }
			]
		}
		facetKeys.forEach((key, index) => {
			facetBranches[`count_${index}`] = [
				{ $match: narrowingMatch(key) },
				{ $unwind: '$attributes' },
				{ $match: { 'attributes.k': key } },
				{ $group: { _id: { v: { $toString: '$attributes.v' }, variant: '$_id' } } },
				{ $group: { _id: '$_id.v', count: { $sum: 1 } } }
			]
		})

		const facetPipeline: any[] = [
			{ $match: { category_id: categoryObjectId, status: ProductStatus.ACTIVE } },
			// Only the attributes are joined: the branches need nothing else from the product,
			// and its description HTML would otherwise be most of what `$facet` holds in memory.
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					pipeline: [{ $project: { _id: 0, attributes: 1 } }],
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{
				$project: {
					price: 1,
					color_id: 1,
					color_family: 1,
					attributes: '$product.attributes'
				}
			},
			{ $facet: facetBranches }
		]

		const [catalogResult, priceRangeResult, facetResult] = await Promise.all([
			this.model.aggregate(pipeline).exec(),
			this.model.aggregate(priceRangePipeline).exec(),
			this.model.aggregate<FacetRows>(facetPipeline).exec()
		])

		const items = catalogResult[0]?.items ?? []
		const total = catalogResult[0]?.meta[0]?.total ?? 0
		const priceRange = priceRangeResult[0] ?? { min: 0, max: 0 }
		const facetRows: Partial<FacetRows> = facetResult[0] ?? {}

		const valuesByKey = new Map<string, string[]>()
		for (const row of facetRows.values ?? []) {
			// Belt and braces with the `$match` in the `values` branch: a blank value must not
			// reach `facets` — nor, through it, the deprecated `filter_options` (I-4).
			if (!isNamedFacetValue(row._id.v)) continue
			const list = valuesByKey.get(row._id.k) ?? []
			list.push(row._id.v)
			valuesByKey.set(row._id.k, list)
		}
		const toCounts = (rows: CountRow[] = []) =>
			new Map<string, number>(rows.map(row => [row._id, row.count]))

		const facets: Record<string, CatalogFacetValue[]> = {}
		facetKeys.forEach((key, index) => {
			const counts = toCounts(facetRows[`count_${index}`])
			facets[key] = mergeFacetValues(valuesByKey.get(key) ?? [], counts)
		})

		const colorCounts = toCounts(facetRows.color_count)
		// The swatch row is ordered here rather than by the `color_all` branch, so the payload
		// depends on the dictionary alone and not on the order Mongo answered in (I-21): by the
		// representative's `order` — the same number the old `$sort` used, since the
		// representative is the family's lowest — then by family name.
		const colorOptions: CatalogColorOption[] = (facetRows.color_all ?? [])
			.map(row => ({ family: row._id, swatch: pickFamilySwatch(row.candidates) }))
			.sort((a, b) => a.swatch.order - b.swatch.order || compareStrings(a.family, b.family))
			.map(({ family, swatch }) => ({
				family,
				count: colorCounts.get(family) ?? 0,
				hex_stops: swatch.hex_stops
			}))

		/**
		 * @deprecated Derived from `facets` for one release (TD-0008 §5.3): the two services
		 * deploy independently, so a storefront built before this change may briefly read a
		 * backend built after it. Removed by Plan-0007 task 15 once the release is accepted.
		 */
		const filterOptions: Record<string, string[]> = {}
		for (const [key, values] of Object.entries(facets)) {
			filterOptions[key] = values.map(entry => entry.value)
		}

		return {
			items,
			pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
			price_range: { min: priceRange.min ?? 0, max: priceRange.max ?? 0 },
			facets,
			filter_options: filterOptions,
			color_options: colorOptions
		}
	}
}

/**
 * Sentinel for the colour dimension in `narrowingMatch`: colour is filtered on the variant
 * (`color_family`), not through `attributes`, so it cannot be named by an attribute key.
 */
const COLOR_DIMENSION = Symbol('color')

/**
 * The colour dimension as a landing pins it in `filters`. `Landing.filters` is a free
 * `attrKey -> values[]` map, and this key is the one `ProductService.getCatalog` takes out of the
 * query string for `colorFamilies` instead of the attribute filters — the count has to take it
 * out of the same place, or the admin column would contradict the page (I-g).
 */
const COLOR_FAMILY_FILTER_KEY = 'color_family'

/** `{ _id: value, count }` as a `$group … { $sum: 1 }` branch emits it. */
interface CountRow {
	_id: string
	count: number
}

/** The single document the facet `$facet` returns: one array per branch. */
interface FacetRows {
	values: { _id: { k: string; v: string } }[]
	color_all: { _id: string; candidates: ColorSwatchCandidate[] }[]
	color_count: CountRow[]
	[countBranch: `count_${number}`]: CountRow[]
}

/** One dictionary colour a family's swatch could be painted from. */
interface ColorSwatchCandidate {
	order: number
	name_en: string
	hex_stops: string[]
}

/**
 * The one dictionary colour that paints a family's swatch: the lowest `order` — the field the
 * admin sorts the dictionary with — with `name_en` as the tiebreaker. Both belong to the
 * dictionary alone, and `name_en` is unique in it, so the rule is total: the same dictionary
 * always yields the same emblem, whatever order the candidates arrive in and whichever narrowing
 * the shopper has applied. The family's most popular colour would read as "meaningful" too, but
 * it repaints the emblem whenever a variant is archived or a new one is imported (I-21).
 */
function pickFamilySwatch(candidates: ColorSwatchCandidate[] = []): ColorSwatchCandidate {
	let best: ColorSwatchCandidate | null = null
	for (const candidate of candidates) {
		if (!best || compareSwatchCandidates(candidate, best) < 0) best = candidate
	}
	return best ?? { order: 0, name_en: '', hex_stops: [] }
}

function compareSwatchCandidates(a: ColorSwatchCandidate, b: ColorSwatchCandidate): number {
	return (a.order ?? 0) - (b.order ?? 0) || compareStrings(a.name_en, b.name_en)
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Is this a value the sidebar can label? The aggregation stringifies the stored value, so a
 * legal `0` or `false` arrives as '0'/'false' and passes; a required attribute left blank in the
 * admin form arrives as '' (or as spaces) and is not a value of the dimension at all (I-4).
 */
function isNamedFacetValue(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== ''
}

/**
 * `$facet` branch names are document field names, so they may not start with `$` or contain a
 * dot. An ObjectId hex string is safe on both counts, but it can start with a digit — the
 * prefix keeps the key an ordinary identifier and makes the output readable in a profiler.
 */
function facetKey(landingId: string): string {
	return `l_${landingId}`
}
