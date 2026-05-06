import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { RefreshToken } from '../schemas/refresh-token.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class RefreshTokenRepository extends BaseRepository<RefreshToken> {
	constructor(@InjectModel(RefreshToken.name) model: Model<RefreshToken>) {
		super(model)
	}

	findByTokenHash(hash: string): Promise<HydratedDocument<RefreshToken> | null> {
		return this.model.findOne({ token: hash }).exec()
	}

	async deleteByTokenHash(hash: string): Promise<void> {
		await this.model.deleteMany({ token: hash }).exec()
	}

	async deleteExpiredForUser(userId: string): Promise<void> {
		await this.model.deleteMany({ userId, expiresAt: { $lt: new Date() } }).exec()
	}

	async deleteById(id: Types.ObjectId): Promise<void> {
		await this.model.findByIdAndDelete(id).exec()
	}
}
