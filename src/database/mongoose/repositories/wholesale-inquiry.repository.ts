import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import type * as mongoose from 'mongoose'
import { WholesaleInquiry } from '../schemas/wholesale-inquiry.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class WholesaleInquiryRepository extends BaseRepository<WholesaleInquiry> {
	constructor(@InjectModel(WholesaleInquiry.name) model: Model<WholesaleInquiry>) {
		super(model)
	}

	findAllPaginated(
		filter: mongoose.QueryFilter<WholesaleInquiry>,
		skip: number,
		limit: number
	): Promise<WholesaleInquiry[]> {
		return this.model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec()
	}

	countDocuments(filter: mongoose.QueryFilter<WholesaleInquiry>): Promise<number> {
		return this.model.countDocuments(filter).exec()
	}
}
