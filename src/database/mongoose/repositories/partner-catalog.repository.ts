import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, PipelineStage, Types } from 'mongoose'
import { Category } from '../schemas/category.schema'
import { ProductVariant } from '../schemas/product-variant.schema'
import { ProductStatus } from 'src/common/types/enums'

export type PartnerCatalogRow = {
	sku: string
	name: string
	slug: string
	price: number
	stock: number
	stock_updated_at: Date | null
	images?: string[]
	weight_g?: number | null
	v_value?: string | null
	category: { _id: Types.ObjectId; name: string; slug: string }
	product: {
		description?: { html?: string }
		attributes?: { k: string; l: string; v: string | number | boolean }[]
		variant_type?: { key: string; label: string }
	}
}
@Injectable()
export class PartnerCatalogRepository {
	constructor(
		@InjectModel(Category.name) private readonly categoryModel: Model<Category>,
		@InjectModel(ProductVariant.name) private readonly variants: Model<ProductVariant>
	) {}
	// Use the same eligibility rules for counts, enumeration and product cards. Broken
	// references cannot advertise SKUs whose cards the integration can never retrieve.
	private joins(): PipelineStage[] {
		return [
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					pipeline: [
						{
							$project: {
								category_id: 1,
								description: 1,
								attributes: 1,
								variant_type: 1
							}
						}
					],
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{ $match: { $expr: { $eq: ['$category_id', '$product.category_id'] } } },
			{
				$lookup: {
					from: 'categories',
					localField: 'category_id',
					foreignField: '_id',
					pipeline: [{ $project: { name: 1, slug: 1 } }],
					as: 'category'
				}
			},
			{ $unwind: '$category' }
		]
	}
	async categories() {
		const [categories, counts] = await Promise.all([
			this.categoryModel
				.find()
				.select('_id name slug')
				.sort({ order: 1, _id: 1 })
				.lean()
				.exec(),
			this.variants
				.aggregate<{
					_id: Types.ObjectId
					count: number
				}>([
					{ $match: { status: ProductStatus.ACTIVE } },
					...this.joins(),
					{ $group: { _id: '$category_id', count: { $sum: 1 } } }
				])
				.exec()
		])
		const byId = new Map(counts.map(row => [row._id.toString(), row.count]))
		return categories.map(category => ({
			id: category._id.toString(),
			name: category.name,
			slug: category.slug,
			parent_id: null,
			sku_count: byId.get(category._id.toString()) ?? 0
		}))
	}
	categoryExists(id: string) {
		return this.categoryModel.exists({ _id: id }).exec()
	}
	skus(categoryId: string | undefined, after: string | undefined, limit: number) {
		return this.variants
			.aggregate<{ sku: string }>([
				{
					$match: {
						status: ProductStatus.ACTIVE,
						...(categoryId ? { category_id: new Types.ObjectId(categoryId) } : {}),
						...(after ? { sku: { $gt: after } } : {})
					}
				},
				{ $sort: { sku: 1 } },
				...this.joins(),
				{ $limit: limit + 1 },
				{ $project: { _id: 0, sku: 1 } }
			])
			.collation({ locale: 'simple' })
			.exec()
	}
	lookup(skus: string[]) {
		return this.variants
			.aggregate<PartnerCatalogRow>([
				{ $match: { sku: { $in: skus }, status: ProductStatus.ACTIVE } },
				...this.joins(),
				{
					$project: {
						_id: 0,
						sku: 1,
						name: 1,
						slug: 1,
						price: 1,
						stock: 1,
						stock_updated_at: 1,
						images: 1,
						weight_g: 1,
						v_value: 1,
						'product.description.html': 1,
						'product.attributes': 1,
						'product.variant_type': 1,
						category: 1
					}
				}
			])
			.exec()
	}
}
