import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common'
import { randomInt } from 'crypto'
import { DiscountCouponRepository } from 'src/database/mongoose/repositories/discount-coupon.repository'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'
import { CreateDiscountCouponDto } from './dto/create-discount-coupon.dto'
import { GetDiscountCouponsQueryDto } from './dto/get-discount-coupons-query.dto'
import { UpdateDiscountCouponDto } from './dto/update-discount-coupon.dto'

@Injectable()
export class DiscountCouponService {
	private static readonly NUMBER_PREFIX = 'DIS-'
	private static readonly NUMBER_LENGTH = 7
	private static readonly CODE_LENGTH = 10
	private static readonly CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
	private static readonly MAX_GENERATION_ATTEMPTS = 10

	constructor(
		private readonly discountCouponRepository: DiscountCouponRepository,
		private readonly numbersRepository: NumbersRepository
	) {}

	private generateRandomCodeSuffix(): string {
		let suffix = ''
		for (let i = 0; i < DiscountCouponService.CODE_LENGTH; i += 1) {
			const idx = randomInt(0, DiscountCouponService.CODE_CHARS.length)
			suffix += DiscountCouponService.CODE_CHARS[idx]
		}
		return suffix
	}

	private async generateUniqueCouponCode(): Promise<string> {
		for (
			let attempt = 0;
			attempt < DiscountCouponService.MAX_GENERATION_ATTEMPTS;
			attempt += 1
		) {
			const code = this.generateRandomCodeSuffix()
			const existing = await this.discountCouponRepository.findByCode(code)
			if (!existing) return code
		}
		throw new InternalServerErrorException('Failed to generate a unique discount coupon code')
	}

	private formatDiscountNumber(sequence: number): string {
		return `${DiscountCouponService.NUMBER_PREFIX}${String(sequence).padStart(
			DiscountCouponService.NUMBER_LENGTH,
			'0'
		)}`
	}

	async findAll(query: GetDiscountCouponsQueryDto) {
		const { is_active, q, page = 1, limit = 20 } = query
		const filter: Record<string, unknown> = {}
		if (is_active !== undefined) filter.is_active = is_active
		if (q?.trim()) filter.code = { $regex: q.trim().toUpperCase(), $options: 'i' }

		const skip = (page - 1) * limit
		const [items, total] = await Promise.all([
			this.discountCouponRepository.findAllPaginated(filter, skip, limit),
			this.discountCouponRepository.countDocuments(filter)
		])

		return { items, total, page, limit }
	}

	async create(dto: CreateDiscountCouponDto) {
		const nextNumberSequence = await this.numbersRepository.increment('discount_coupon')
		const number = this.formatDiscountNumber(nextNumberSequence)
		const code = await this.generateUniqueCouponCode()
		return this.discountCouponRepository.create({
			number,
			code,
			discount_percent: dto.discount_percent,
			valid_until: new Date(dto.valid_until),
			is_active: dto.is_active ?? true
		})
	}

	async update(id: string, dto: UpdateDiscountCouponDto) {
		const updated = await this.discountCouponRepository.update(
			{ _id: id },
			{
				$set: {
					...(dto.discount_percent !== undefined
						? { discount_percent: dto.discount_percent }
						: {}),
					...(dto.valid_until !== undefined
						? { valid_until: new Date(dto.valid_until) }
						: {}),
					...(dto.is_active !== undefined ? { is_active: dto.is_active } : {})
				}
			}
		)
		if (!updated) throw new NotFoundException('Discount coupon not found')
		return updated
	}

	async findById(id: string) {
		const coupon = await this.discountCouponRepository.findById(id)
		if (!coupon) throw new NotFoundException('Discount coupon not found')
		return coupon
	}

	async delete(id: string) {
		const deleted = await this.discountCouponRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Discount coupon not found')
		return { message: 'Discount coupon deleted' }
	}

	async validateCoupon(rawCode: string) {
		const code = rawCode.trim().toUpperCase()
		const coupon = await this.discountCouponRepository.findByCode(code)

		if (!coupon) {
			return { valid: false, reason: 'NOT_FOUND' as const }
		}
		if (!coupon.is_active) {
			return { valid: false, reason: 'INACTIVE' as const }
		}
		if (new Date(coupon.valid_until).getTime() < Date.now()) {
			return { valid: false, reason: 'EXPIRED' as const }
		}

		return {
			valid: true,
			coupon: {
				id: coupon._id,
				number: coupon.number,
				code: coupon.code,
				discount_percent: coupon.discount_percent,
				valid_until: coupon.valid_until
			}
		}
	}
}
