import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Order } from '../schemas/order.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class OrderRepository extends BaseRepository<Order> {
	constructor(@InjectModel(Order.name) model: Model<Order>) {
		super(model)
	}

	findByOrderNumber(orderNumber: string) {
		return this.model.findOne({ order_number: orderNumber }).exec()
	}

	findAllPaginated(filter: Record<string, unknown>, skip: number, limit: number) {
		return this.model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec()
	}

	findAllByUserPaginated(
		userId: Types.ObjectId,
		filter: Record<string, unknown>,
		skip: number,
		limit: number
	) {
		return this.model
			.find({ user_id: userId, ...filter })
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(limit)
			.lean()
			.exec()
	}

	findByIdAndUserId(id: Types.ObjectId, userId: Types.ObjectId) {
		return this.model.findOne({ _id: id, user_id: userId }).exec()
	}

	countDocumentsByUser(userId: Types.ObjectId, filter: Record<string, unknown>) {
		return this.model.countDocuments({ user_id: userId, ...filter }).exec()
	}

	countDocuments(filter: Record<string, unknown>) {
		return this.model.countDocuments(filter).exec()
	}
}
