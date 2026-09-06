import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Product } from '../schemas/product.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class ProductRepository extends BaseRepository<Product> {
	constructor(@InjectModel(Product.name) model: Model<Product>) {
		super(model)
	}

	findByCategoryId(categoryId: string): Promise<Product[]> {
		return this.findAll({ category_id: new Types.ObjectId(categoryId) })
	}

	findByVendorId(vendorId: string): Promise<Product[]> {
		return this.findAll({ vendor_id: new Types.ObjectId(vendorId) })
	}

	/** Every product of the given categories — the search fallback for a category-name query. */
	async findIdsByCategoryIds(categoryIds: Types.ObjectId[]): Promise<Types.ObjectId[]> {
		if (categoryIds.length === 0) return []
		const rows = await this.model
			.find({ category_id: { $in: categoryIds } }, { _id: 1 })
			.lean<Array<{ _id: Types.ObjectId }>>()
			.exec()
		return rows.map(r => r._id)
	}

	async findByTextSearch(query: string): Promise<Array<{ _id: Types.ObjectId; score: number }>> {
		return this.model
			.find({ $text: { $search: query } }, { score: { $meta: 'textScore' }, _id: 1 })
			.sort({ score: { $meta: 'textScore' } })
			.limit(200)
			.lean<Array<{ _id: Types.ObjectId; score: number }>>()
			.exec()
	}
}
