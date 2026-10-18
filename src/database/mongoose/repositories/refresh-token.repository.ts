import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { RefreshToken } from '../schemas/refresh-token.schema'
import { BaseRepository } from './base.repository'
import { REFRESH_REUSE_GRACE_MS } from 'src/common/constants'

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

	/**
	 * Housekeeping on every save: expired tokens, and consumed tokens whose reuse window has
	 * closed. Keeping the latter any longer would only widen the time a leaked token stays usable.
	 */
	async deleteExpiredForUser(userId: string): Promise<void> {
		const now = Date.now()
		await this.model
			.deleteMany({
				userId,
				$or: [
					{ expiresAt: { $lt: new Date(now) } },
					{ usedAt: { $lt: new Date(now - REFRESH_REUSE_GRACE_MS) } }
				]
			})
			.exec()
	}

	/** Marks the token consumed; a no-op when another request consumed it first. */
	async markUsed(id: Types.ObjectId, usedAt: Date): Promise<void> {
		await this.model.updateOne({ _id: id, usedAt: null }, { $set: { usedAt } }).exec()
	}

	async deleteById(id: Types.ObjectId): Promise<void> {
		await this.model.findByIdAndDelete(id).exec()
	}
}
