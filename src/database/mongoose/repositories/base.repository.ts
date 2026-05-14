import { HydratedDocument, Model } from 'mongoose'
import type * as mongoose from 'mongoose'

export abstract class BaseRepository<T> {
	constructor(protected readonly model: Model<T>) {}

	create(data: Partial<T>): Promise<HydratedDocument<T>> {
		return this.model.create(data)
	}

	findById(id: string): Promise<HydratedDocument<T> | null> {
		return this.model.findById(id).exec()
	}

	findOne(filter: mongoose.QueryFilter<T>): Promise<HydratedDocument<T> | null> {
		return this.model.findOne(filter).exec()
	}

	findAll(filter: mongoose.QueryFilter<T> = {}): Promise<T[]> {
		return this.model.find(filter).lean().exec()
	}

	update(
		filter: mongoose.QueryFilter<T>,
		data: mongoose.UpdateQuery<T>
	): Promise<HydratedDocument<T> | null> {
		return this.model.findOneAndUpdate(filter, data, { new: true }).exec()
	}

	async delete(filter: mongoose.QueryFilter<T>): Promise<boolean> {
		const result = await this.model.deleteOne(filter).exec()
		return result.deletedCount > 0
	}
}
