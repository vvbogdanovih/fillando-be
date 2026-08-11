import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { PaymentProvider } from 'src/common/types/enums'
import { PaymentProviderCredentials } from '../schemas/payment-provider.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class PaymentProviderRepository extends BaseRepository<PaymentProviderCredentials> {
	constructor(
		@InjectModel(PaymentProviderCredentials.name) model: Model<PaymentProviderCredentials>
	) {
		super(model)
	}

	findActiveByProvider(provider: PaymentProvider) {
		return this.findOne({ provider, is_active: true })
	}

	/**
	 * Activates the given record and deactivates every other record of the same
	 * provider, so at most one credential set per provider is ever active.
	 */
	async activate(id: string) {
		const target = await this.model.findById(id).exec()
		if (!target) return null
		await this.model
			.updateMany({ provider: target.provider }, { $set: { is_active: false } })
			.exec()
		return this.model
			.findByIdAndUpdate(id, { $set: { is_active: true } }, { returnDocument: 'after' })
			.exec()
	}
}
