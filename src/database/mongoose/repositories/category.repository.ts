import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import { Category } from '../schemas/category.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class CategoryRepository extends BaseRepository<Category> {
	constructor(@InjectModel(Category.name) model: Model<Category>) {
		super(model)
	}

	findBySlug(slug: string): Promise<HydratedDocument<Category> | null> {
		return this.findOne({ slug })
	}
}
