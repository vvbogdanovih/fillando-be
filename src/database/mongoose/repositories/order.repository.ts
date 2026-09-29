import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentStatus } from 'src/common/types/enums'
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

	/**
	 * Orders whose parcel the delivery tracker follows: carrying a TTN, not a pickup, in one of
	 * `statuses`, and placed after `since`. Lean and narrowed to what the tracker reads.
	 */
	findTrackable(statuses: OrderStatus[], since: Date) {
		return this.model
			.find({
				order_status: { $in: statuses },
				delivery_method: { $ne: DeliveryMethod.PICKUP },
				nova_post_ttn: { $nin: [null, ''] },
				createdAt: { $gte: since }
			})
			.select(
				'order_number order_status payment_status delivery_method nova_post_ttn nova_post_alerted_code customer'
			)
			.lean()
			.exec()
	}

	countDocuments(filter: Record<string, unknown>) {
		return this.model.countDocuments(filter).exec()
	}

	/**
	 * Units sold per variant since `since`, counting PAID orders only — the sales-velocity label
	 * of the Google Shopping feed (`custom_label_4`, TD-0006 §5.3). Keys are variant ids as
	 * strings. Not a hot path: the feed job runs hourly.
	 */
	async countSoldByVariantSince(since: Date): Promise<Map<string, number>> {
		const rows = await this.model
			.aggregate<{
				_id: Types.ObjectId
				units: number
			}>([
				{ $match: { payment_status: PaymentStatus.PAID, createdAt: { $gte: since } } },
				{ $unwind: '$items' },
				{ $group: { _id: '$items.variant_id', units: { $sum: '$items.quantity' } } }
			])
			.exec()
		return new Map(rows.map(r => [String(r._id), r.units]))
	}

	findAllByDateRange(filter: Record<string, unknown>, dateFrom: Date, dateTo: Date) {
		return this.model
			.find({ ...filter, createdAt: { $gte: dateFrom, $lte: dateTo } })
			.sort({ createdAt: -1 })
			.limit(10000)
			.lean()
			.exec()
	}
}
