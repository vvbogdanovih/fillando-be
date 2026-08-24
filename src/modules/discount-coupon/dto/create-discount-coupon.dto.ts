import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsBoolean, IsDateString, IsNumber, IsOptional, Max, Min } from 'class-validator'

export class CreateDiscountCouponDto {
	@ApiProperty({ example: 15, minimum: 0, maximum: 100 })
	@IsNumber()
	@Min(0)
	@Max(100)
	discount_percent: number

	@ApiProperty({
		example: '2026-12-31T23:59:59.000Z',
		description: 'Coupon expiration datetime in ISO format'
	})
	@IsDateString()
	valid_until: string

	@ApiPropertyOptional({ example: true, default: true })
	@IsOptional()
	@IsBoolean()
	is_active?: boolean

	@ApiPropertyOptional({
		example: false,
		default: false,
		description:
			'Reusable coupons stay active after each order; single-use coupons are deactivated on first use'
	})
	@IsOptional()
	@IsBoolean()
	is_reusable?: boolean
}
