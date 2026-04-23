import { Injectable, NotFoundException } from '@nestjs/common'
import { PaymentDetailsRepository } from 'src/database/mongoose/repositories/payment-details.repository'
import { CreatePaymentDetailsDto } from './dto/create-payment-details.dto'
import { UpdatePaymentDetailsDto } from './dto/update-payment-details.dto'

@Injectable()
export class PaymentDetailsService {
	constructor(private readonly paymentDetailsRepository: PaymentDetailsRepository) {}

	findAll() {
		return this.paymentDetailsRepository.findAll({})
	}

	async findById(id: string) {
		const details = await this.paymentDetailsRepository.findById(id)
		if (!details) throw new NotFoundException('Payment details not found')
		return details
	}

	create(dto: CreatePaymentDetailsDto) {
		return this.paymentDetailsRepository.create(dto)
	}

	async update(id: string, dto: UpdatePaymentDetailsDto) {
		const updated = await this.paymentDetailsRepository.update({ _id: id }, dto)
		if (!updated) throw new NotFoundException('Payment details not found')
		return updated
	}

	async delete(id: string) {
		const deleted = await this.paymentDetailsRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Payment details not found')
		return { message: 'Payment details deleted' }
	}

	findActive() {
		return this.paymentDetailsRepository.findActive()
	}

	async activate(id: string) {
		const activated = await this.paymentDetailsRepository.activate(id)
		if (!activated) throw new NotFoundException('Payment details not found')
		return activated
	}
}
