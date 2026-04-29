import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import type * as mongoose from 'mongoose'
import { User } from '../schemas/user.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class UserRepository extends BaseRepository<User> {
	constructor(@InjectModel(User.name) model: Model<User>) {
		super(model)
	}

	findByEmail(email: string): Promise<HydratedDocument<User> | null> {
		return this.findOne({ email })
	}

	findByPhone(phone: string): Promise<HydratedDocument<User> | null> {
		return this.findOne({ phone })
	}

	findAllPaginated(
		filter: mongoose.QueryFilter<User>,
		skip: number,
		limit: number
	): Promise<User[]> {
		return this.model
			.find(filter)
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(limit)
			.lean()
			.exec() as unknown as Promise<User[]>
	}

	countDocuments(filter: mongoose.QueryFilter<User>): Promise<number> {
		return this.model.countDocuments(filter).exec()
	}
}
