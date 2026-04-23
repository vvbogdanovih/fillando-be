import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { PaymentDetails } from '../schemas/payment-details.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class PaymentDetailsRepository extends BaseRepository<PaymentDetails> {
	constructor(@InjectModel(PaymentDetails.name) model: Model<PaymentDetails>) {
		super(model)
	}

	findByIban(iban: string) {
		return this.findOne({ iban })
	}

	findActive() {
		return this.findOne({ is_available: true })
	}

	async activate(id: string) {
		await this.model.updateMany({}, { $set: { is_available: false } }).exec()
		return this.model
			.findByIdAndUpdate(id, { $set: { is_available: true } }, { new: true })
			.exec()
	}
}
