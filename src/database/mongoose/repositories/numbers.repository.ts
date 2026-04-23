import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { Numbers } from '../schemas/numbers.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class NumbersRepository extends BaseRepository<Numbers> {
	constructor(@InjectModel(Numbers.name) model: Model<Numbers>) {
		super(model)
	}

	async increment(
		field: keyof Pick<Numbers, 'sku' | 'order' | 'discount_coupon'>
	): Promise<number> {
		const doc = await this.model
			.findOneAndUpdate({}, { $inc: { [field]: 1 } }, { new: true, upsert: true })
			.exec()
		return doc[field]
	}
}
