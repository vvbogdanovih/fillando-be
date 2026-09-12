import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { Types } from 'mongoose'
import { PartnerApiRepository } from 'src/database/mongoose/repositories/partner-api.repository'
import {
	BulkPartnerAvailabilityResponseDto,
	PartnerAvailabilityDto,
	PartnerTokenDto
} from './partner-api.dto'

export const hashPartnerToken = (token: string) => createHash('sha256').update(token).digest('hex')
@Injectable()
export class PartnerApiService {
	private readonly logger = new Logger(PartnerApiService.name)
	constructor(private readonly repository: PartnerApiRepository) {}
	private metadata(row: {
		_id: Types.ObjectId
		name: string
		prefix: string
		createdAt: Date
		revoked_at: Date | null
		last_used_at: Date | null
	}): PartnerTokenDto {
		return {
			id: row._id.toString(),
			name: row.name,
			prefix: row.prefix,
			created_at: row.createdAt,
			revoked_at: row.revoked_at,
			last_used_at: row.last_used_at
		}
	}
	async create(name: string, userId: string) {
		const token = 'flnd_live_' + randomBytes(32).toString('hex')
		const row = await this.repository.create({
			name,
			token_hash: hashPartnerToken(token),
			prefix: token.slice(0, 17),
			created_by: new Types.ObjectId(userId)
		})
		return { ...this.metadata(row), token }
	}
	async list() {
		return (await this.repository.list()).map(row => this.metadata(row))
	}
	async revoke(id: string) {
		if (!/^[a-fA-F0-9]{24}$/.test(id)) throw new BadRequestException('Invalid token ID')
		if (!(await this.repository.revoke(id))) throw new NotFoundException('Token not found')
	}
	async authenticate(authorization?: string) {
		const match = /^Bearer (flnd_live_[a-f0-9]{64})$/i.exec(authorization ?? '')
		if (!match) throw new UnauthorizedException('Invalid API token')
		const row = await this.repository.authenticate(hashPartnerToken(match[1]))
		if (!row) throw new UnauthorizedException('Invalid API token')
		void this.repository
			.touch(row._id)
			.catch(() => this.logger.warn('Could not update API token last-used timestamp'))
		return row._id.toString()
	}
	async bulkAvailability(skus: string[]): Promise<BulkPartnerAvailabilityResponseDto> {
		const uniqueSkus = [...new Set(skus)]
		const rows = await this.repository.bulkAvailability(uniqueSkus)
		const bySku = new Map(rows.map(row => [row.sku, row]))
		const items: PartnerAvailabilityDto[] = []
		const not_found: string[] = []
		for (const sku of uniqueSkus) {
			const row = bySku.get(sku)
			if (row) items.push(this.toAvailability(row))
			else not_found.push(sku)
		}
		return { items, not_found }
	}
	async availability(sku: string) {
		const row = await this.repository.availability(sku)
		if (!row) throw new NotFoundException('Product not found')
		return this.toAvailability(row)
	}
	private toAvailability(row: {
		sku: string
		stock: number
		stock_updated_at: Date | null
	}): PartnerAvailabilityDto {
		const quantity = Number.isFinite(row.stock) ? Math.max(0, row.stock) : 0
		return {
			sku: row.sku,
			in_stock: quantity > 0,
			quantity,
			stock_updated_at: row.stock_updated_at?.toISOString() ?? null
		}
	}
}
