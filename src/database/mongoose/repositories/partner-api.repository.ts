import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { PartnerApiToken } from '../schemas/partner-api-token.schema'
import { ProductVariant } from '../schemas/product-variant.schema'
import { ProductStatus } from 'src/common/types/enums'

@Injectable()
export class PartnerApiRepository {
	constructor(
		@InjectModel(PartnerApiToken.name) private readonly tokens: Model<PartnerApiToken>,
		@InjectModel(ProductVariant.name) private readonly variants: Model<ProductVariant>
	) {}
	create(data: Partial<PartnerApiToken>) {
		return this.tokens.create(data)
	}
	list() {
		return this.tokens
			.find()
			.select('_id name prefix createdAt revoked_at last_used_at')
			.sort({ createdAt: -1 })
			.lean()
			.exec()
	}
	authenticate(hash: string) {
		return this.tokens
			.findOne({ token_hash: hash, revoked_at: null })
			.select('_id')
			.lean()
			.exec()
	}
	touch(id: Types.ObjectId) {
		return this.tokens
			.updateOne(
				{
					_id: id,
					$or: [
						{ last_used_at: null },
						{ last_used_at: { $lt: new Date(Date.now() - 60_000) } }
					]
				},
				{ $set: { last_used_at: new Date() } }
			)
			.exec()
	}
	revoke(id: string) {
		return this.tokens
			.findOneAndUpdate(
				{ _id: id },
				[{ $set: { revoked_at: { $ifNull: ['$revoked_at', '$$NOW'] } } }],
				{ returnDocument: 'after', updatePipeline: true }
			)
			.select('_id')
			.lean()
			.exec()
	}
	bulkAvailability(skus: string[]) {
		return this.variants
			.find({ sku: { $in: skus }, status: ProductStatus.ACTIVE })
			.select('sku stock stock_updated_at -_id')
			.lean()
			.exec()
	}
	availability(sku: string) {
		return this.variants
			.findOne({ sku, status: ProductStatus.ACTIVE })
			.select('sku stock stock_updated_at -_id')
			.lean()
			.exec()
	}
}
