import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { Category, Subcategory } from '../schemas/category.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class CategoryRepository extends BaseRepository<Category> {
	constructor(@InjectModel(Category.name) model: Model<Category>) {
		super(model)
	}

	findBySlug(slug: string): Promise<HydratedDocument<Category> | null> {
		return this.findOne({ slug })
	}

	findWithSubcategories(): Promise<Category[]> {
		return this.findAll({})
	}

	addSubcategory(
		categoryId: string,
		subcategoryData: Partial<Subcategory>
	): Promise<HydratedDocument<Category> | null> {
		return this.update({ _id: categoryId }, { $push: { subcategories: subcategoryData } })
	}

	updateSubcategory(
		categoryId: string,
		subcategoryId: string,
		data: Partial<Subcategory>
	): Promise<HydratedDocument<Category> | null> {
		const updateFields: Record<string, unknown> = {}
		for (const [key, val] of Object.entries(data)) {
			updateFields[`subcategories.$.${key}`] = val
		}
		return this.model
			.findOneAndUpdate(
				{ _id: categoryId, 'subcategories._id': new Types.ObjectId(subcategoryId) },
				{ $set: updateFields },
				{ new: true }
			)
			.exec()
	}

	async findSubcategories(categoryId: string): Promise<Subcategory[] | null> {
		const category = await this.model.findById(categoryId, { subcategories: 1 }).lean().exec()
		return category ? (category as any).subcategories : null
	}

	async findSubcategoryById(
		categoryId: string,
		subcategoryId: string
	): Promise<Subcategory | null> {
		const result = await this.model
			.findOne(
				{ _id: categoryId, 'subcategories._id': new Types.ObjectId(subcategoryId) },
				{ 'subcategories.$': 1 }
			)
			.lean()
			.exec()
		return result ? (result as any).subcategories[0] : null
	}

	replaceSubcategory(
		categoryId: string,
		subcategoryId: string,
		data: Subcategory
	): Promise<HydratedDocument<Category> | null> {
		return this.model
			.findOneAndUpdate(
				{ _id: categoryId, 'subcategories._id': new Types.ObjectId(subcategoryId) },
				{
					$set: { 'subcategories.$': { _id: new Types.ObjectId(subcategoryId), ...data } }
				},
				{ new: true }
			)
			.exec()
	}

	removeSubcategory(
		categoryId: string,
		subcategoryId: string
	): Promise<HydratedDocument<Category> | null> {
		return this.model
			.findOneAndUpdate(
				{ _id: categoryId },
				{ $pull: { subcategories: { _id: new Types.ObjectId(subcategoryId) } } },
				{ new: true }
			)
			.exec()
	}
}
