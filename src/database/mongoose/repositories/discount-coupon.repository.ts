import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { DiscountCoupon } from '../schemas/discount-coupon.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class DiscountCouponRepository extends BaseRepository<DiscountCoupon> {
	constructor(@InjectModel(DiscountCoupon.name) model: Model<DiscountCoupon>) {
		super(model)
	}

	findActiveByCode(code: string) {
		return this.model.findOne({ code, is_active: true }).exec()
	}

	findByCode(code: string) {
		return this.model.findOne({ code }).exec()
	}

	findAllPaginated(filter: Record<string, unknown>, skip: number, limit: number) {
		return this.model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec()
	}

	countDocuments(filter: Record<string, unknown>) {
		return this.model.countDocuments(filter).exec()
	}
}
