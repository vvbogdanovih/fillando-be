import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types, UpdateQuery } from 'mongoose'
import { Cart } from '../schemas/cart.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class CartRepository extends BaseRepository<Cart> {
	constructor(@InjectModel(Cart.name) model: Model<Cart>) {
		super(model)
	}

	findByUserId(userId: string) {
		return this.findOne({ user_id: new Types.ObjectId(userId) })
	}

	upsertByUserId(userId: string, update: UpdateQuery<Cart>) {
		return this.model
			.findOneAndUpdate({ user_id: new Types.ObjectId(userId) }, update, {
				returnDocument: 'after',
				upsert: true
			})
			.exec()
	}
}
