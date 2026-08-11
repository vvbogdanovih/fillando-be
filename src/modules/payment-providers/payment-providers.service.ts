import { Injectable, NotFoundException } from '@nestjs/common'
import { PaymentProviderRepository } from 'src/database/mongoose/repositories/payment-provider.repository'
import { PaymentProvider } from 'src/common/types/enums'
import { decrypt, encrypt } from 'src/common/services/crypto.util'
import {
	PaymentProviderCredentials,
	PaymentProviderDocument
} from 'src/database/mongoose/schemas/payment-provider.schema'
import { CreatePaymentProviderDto } from './dto/create-payment-provider.dto'
import { UpdatePaymentProviderDto } from './dto/update-payment-provider.dto'

export interface ProviderCredentials {
	public_key: string
	private_key: string
	sandbox: boolean
}

@Injectable()
export class PaymentProvidersService {
	constructor(private readonly repository: PaymentProviderRepository) {}

	/**
	 * Strips the encrypted secret from any record before it leaves the service.
	 * The private key is never exposed over HTTP.
	 */
	private mask(doc: PaymentProviderDocument | PaymentProviderCredentials) {
		const hydrated = doc as PaymentProviderDocument
		const source: unknown = typeof hydrated.toObject === 'function' ? hydrated.toObject() : doc
		const plain = { ...(source as Record<string, unknown>) }
		delete plain.private_key_enc
		return { ...plain, has_private_key: true }
	}

	async findAll() {
		const items = await this.repository.findAll({})
		return items.map(item => this.mask(item))
	}

	async findById(id: string) {
		const doc = await this.repository.findById(id)
		if (!doc) throw new NotFoundException('Payment provider not found')
		return this.mask(doc)
	}

	async findActiveByProvider(provider: PaymentProvider) {
		const doc = await this.repository.findActiveByProvider(provider)
		return doc ? this.mask(doc) : null
	}

	async create(dto: CreatePaymentProviderDto) {
		const doc = await this.repository.create({
			provider: dto.provider,
			label: dto.label,
			public_key: dto.public_key,
			private_key_enc: encrypt(dto.private_key),
			sandbox: dto.sandbox ?? false,
			is_active: false
		})
		return this.mask(doc)
	}

	async update(id: string, dto: UpdatePaymentProviderDto) {
		const set: Record<string, unknown> = {}
		if (dto.label !== undefined) set.label = dto.label
		if (dto.public_key !== undefined) set.public_key = dto.public_key
		if (dto.sandbox !== undefined) set.sandbox = dto.sandbox
		if (dto.private_key !== undefined) set.private_key_enc = encrypt(dto.private_key)

		const updated = await this.repository.update({ _id: id }, { $set: set })
		if (!updated) throw new NotFoundException('Payment provider not found')
		return this.mask(updated)
	}

	async delete(id: string) {
		const deleted = await this.repository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Payment provider not found')
		return { message: 'Payment provider deleted' }
	}

	async activate(id: string) {
		const activated = await this.repository.activate(id)
		if (!activated) throw new NotFoundException('Payment provider not found')
		return this.mask(activated)
	}

	/**
	 * Internal use only (never exposed via a controller): returns the decrypted
	 * credentials of the active provider, for signing/verifying payments.
	 */
	async getActiveCredentials(provider: PaymentProvider): Promise<ProviderCredentials> {
		const doc = await this.repository.findActiveByProvider(provider)
		if (!doc) {
			throw new NotFoundException(`No active ${provider} payment provider configured`)
		}
		return {
			public_key: doc.public_key,
			private_key: decrypt(doc.private_key_enc),
			sandbox: doc.sandbox
		}
	}
}
