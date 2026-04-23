import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator'

export class GetDiscountCouponsQueryDto {
	@ApiPropertyOptional({
		description: 'Filter by active flag',
		example: true
	})
	@IsOptional()
	@Type(() => Boolean)
	@IsBoolean()
	is_active?: boolean

	@ApiPropertyOptional({
		description: 'Search by coupon code substring',
		example: 'ZY64'
	})
	@IsOptional()
	@IsString()
	@MaxLength(50)
	q?: string

	@ApiPropertyOptional({ default: 1, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	page?: number = 1

	@ApiPropertyOptional({ default: 20, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	limit?: number = 20
}
