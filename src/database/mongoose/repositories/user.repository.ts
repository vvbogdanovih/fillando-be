import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
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
}
