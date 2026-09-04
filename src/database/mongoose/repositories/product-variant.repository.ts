import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { ProductVariant } from '../schemas/product-variant.schema'
import { ProductStatus } from 'src/common/types/enums'
import { BaseRepository } from './base.repository'
import {
	PRICE_SHEET_PUBLIC_PROJECTION,
	toPublicVariant
} from 'src/modules/product/product-public.mappers'
import type { PriceListRawRow } from 'src/modules/product/price-list/price-list.types'

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

	findByProductId(productId: string): Promise<ProductVariant[]> {
		return this.findAll({ product_id: new Types.ObjectId(productId) })
	}

	findByIds(ids: Types.ObjectId[]): Promise<ProductVariant[]> {
		return this.findAll({ _id: { $in: ids } })
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
	 * Public product page. DRAFT/ARCHIVED variants are not found here on purpose, and the
	 * `variant` part goes through {@link toPublicVariant} so supplier fields never leak.
	 */
	async findVariantWithProduct(slug: string) {
		const variant = await this.model
			.findOne({ slug, status: ProductStatus.ACTIVE })
			.lean()
			.exec()
		if (!variant) return null

		const [product, siblings, category] = await Promise.all([
			this.model.db
				.collection('products')
				.findOne(
					{ _id: variant.product_id },
					{ projection: { name: 1, description: 1, attributes: 1, variant_type: 1 } }
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
						status: 1
					}
				)
				.lean()
				.exec(),
			this.model.db
				.collection('categories')
				.findOne({ _id: variant.category_id }, { projection: { slug: 1, name: 1 } })
		])

		if (!product) return null

		return {
			variant: toPublicVariant(variant),
			product: {
				id: String((product as any)._id),
				name: (product as any).name,
				description: (product as any).description,
				attributes: (product as any).attributes,
				variant_type: (product as any).variant_type
			},
			// Same public allowlist as `variant` — one projection for the whole public page.
			siblings: siblings.map(s => toPublicVariant(s)),
			category_slug: (category as any)?.slug ?? null,
			category_name: (category as any)?.name ?? null
		}
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
			matchConditions.push({ product_id: { $in: productIds }, status: 'active' })
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
			{ $unwind: '$product' }
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

	async findCatalogItems(params: {
		category_id: string
		page: number
		limit: number
		price_min?: number
		price_max?: number
		sort: string
		attrFilters: Record<string, string[]>
	}) {
		const { category_id, page, limit, price_min, price_max, sort, attrFilters } = params
		const skip = (page - 1) * limit

		const variantMatch: Record<string, any> = {
			category_id: new Types.ObjectId(category_id),
			status: 'active'
		}
		if (price_min !== undefined || price_max !== undefined) {
			variantMatch.price = {}
			if (price_min !== undefined) variantMatch.price.$gte = price_min
			if (price_max !== undefined) variantMatch.price.$lte = price_max
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
			{ $unwind: '$product' }
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
								main_image: { $ifNull: [{ $arrayElemAt: ['$images', 0] }, null] }
							}
						}
					],
					meta: [{ $count: 'total' }]
				}
			}
		)

		const categoryObjectId = new Types.ObjectId(category_id)

		const priceRangePipeline: any[] = [
			{ $match: { category_id: categoryObjectId, status: 'active' } },
			{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }
		]

		const filterOptionsPipeline: any[] = [
			{ $match: { category_id: categoryObjectId, status: 'active' } },
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{ $unwind: '$product.attributes' },
			{
				$group: {
					_id: '$product.attributes.k',
					values: { $addToSet: { $toString: '$product.attributes.v' } }
				}
			}
		]

		const [catalogResult, priceRangeResult, filterOptionsResult] = await Promise.all([
			this.model.aggregate(pipeline).exec(),
			this.model.aggregate(priceRangePipeline).exec(),
			this.model.aggregate(filterOptionsPipeline).exec()
		])

		const items = catalogResult[0]?.items ?? []
		const total = catalogResult[0]?.meta[0]?.total ?? 0
		const priceRange = priceRangeResult[0] ?? { min: 0, max: 0 }

		const filterOptions: Record<string, string[]> = {}
		for (const entry of filterOptionsResult) {
			filterOptions[entry._id] = (entry.values as string[]).filter(Boolean).sort()
		}

		return {
			items,
			pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
			price_range: { min: priceRange.min ?? 0, max: priceRange.max ?? 0 },
			filter_options: filterOptions
		}
	}
}
