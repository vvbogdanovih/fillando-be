import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { Category } from '../schemas/category.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class CategoryRepository extends BaseRepository<Category> {
	constructor(@InjectModel(Category.name) model: Model<Category>) {
		super(model)
	}

	/**
	 * Categories whose name contains the query, case-insensitively. Storefront search falls
	 * back on this so «філамент» still finds products after the product names lost the word
	 * (TD-0002 short names, migration 3k).
	 */
	findIdsByNameMatch(query: string): Promise<Types.ObjectId[]> {
		const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		if (!escaped) return Promise.resolve([])
		return this.model
			.find({ name: { $regex: escaped, $options: 'i' } }, { _id: 1 })
			.lean<Array<{ _id: Types.ObjectId }>>()
			.exec()
			.then(rows => rows.map(r => r._id))
	}

	findBySlug(slug: string): Promise<HydratedDocument<Category> | null> {
		return this.findOne({ slug })
	}
}
