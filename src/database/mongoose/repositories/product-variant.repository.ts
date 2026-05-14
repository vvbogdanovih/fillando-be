import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { ProductVariant } from '../schemas/product-variant.schema'
import { BaseRepository } from './base.repository'

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

	findBySubcategoryId(subcategoryId: string): Promise<ProductVariant[]> {
		return this.findAll({ subcategory_id: new Types.ObjectId(subcategoryId) })
	}

	findByIds(ids: Types.ObjectId[]): Promise<ProductVariant[]> {
		return this.findAll({ _id: { $in: ids } })
	}

	findAllSlugs(): Promise<Array<{ slug: string; updatedAt: Date }>> {
		return this.model
			.find({}, { slug: 1, updatedAt: 1, _id: 0 })
			.lean<Array<{ slug: string; updatedAt: Date }>>()
			.exec()
	}

	async countAll(): Promise<number> {
		return this.model.countDocuments().exec()
	}

	async findVariantWithProduct(slug: string) {
		const variant = await this.model.findOne({ slug }).lean().exec()
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
					{ product_id: variant.product_id },
					{ _id: 1, name: 1, slug: 1, price: 1, v_value: 1, images: 1, stock: 1 }
				)
				.lean()
				.exec(),
			this.model.db
				.collection('categories')
				.findOne(
					{ 'subcategories._id': variant.subcategory_id },
					{ projection: { slug: 1, subcategories: 1 } }
				)
		])

		if (!product) return null

		const subcategory = (category?.subcategories as any[])?.find(
			s => String(s._id) === String(variant.subcategory_id)
		)

		return {
			variant: {
				id: String(variant._id),
				name: variant.name,
				slug: variant.slug,
				sku: variant.sku,
				price: variant.price,
				stock: variant.stock,
				images: variant.images,
				v_value: variant.v_value,
				vendor_product_sku: variant.vendor_product_sku,
				status: variant.status
			},
			product: {
				id: String((product as any)._id),
				name: (product as any).name,
				description: (product as any).description,
				attributes: (product as any).attributes,
				variant_type: (product as any).variant_type
			},
			siblings: siblings.map(s => ({
				id: String((s as any)._id),
				name: s.name,
				slug: s.slug,
				price: s.price,
				stock: s.stock,
				v_value: s.v_value,
				images: s.images
			})),
			category_slug: (category as any)?.slug ?? null,
			subcategory_slug: subcategory?.slug ?? null
		}
	}

	async findCatalogItems(params: {
		subcategory_id: string
		page: number
		limit: number
		price_min?: number
		price_max?: number
		sort: string
		attrFilters: Record<string, string[]>
	}) {
		const { subcategory_id, page, limit, price_min, price_max, sort, attrFilters } = params
		const skip = (page - 1) * limit

		const variantMatch: Record<string, any> = {
			subcategory_id: new Types.ObjectId(subcategory_id),
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

		const subcategoryObjectId = new Types.ObjectId(subcategory_id)

		const priceRangePipeline: any[] = [
			{ $match: { subcategory_id: subcategoryObjectId, status: 'active' } },
			{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }
		]

		const filterOptionsPipeline: any[] = [
			{ $match: { subcategory_id: subcategoryObjectId, status: 'active' } },
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
