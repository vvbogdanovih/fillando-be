import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsISO8601, IsOptional, Matches, Max, Min, ValidateIf } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { PROMO_PERCENT_MAX, PROMO_PERCENT_MIN } from '../promo-pricing'

/**
 * A promotion for every variant of one product (TD-0012). `promo_percent` is a required key:
 * a number applies, `null` clears — both the percent and the end date — on all variants.
 */
export class SetProductPromotionDto {
	@ApiProperty({ ...API_PROPERTY.PROMO_PERCENT, nullable: true })
	@ValidateIf((_, value) => value !== null)
	@IsInt()
	@Min(PROMO_PERCENT_MIN)
	@Max(PROMO_PERCENT_MAX)
	promo_percent: number | null

	@ApiProperty({ ...API_PROPERTY.PROMO_ENDS_AT, required: false })
	@IsOptional()
	@IsISO8601()
	@Matches(/^\d{4}-\d{2}-\d{2}T/, { message: 'promo_ends_at must be an ISO 8601 date-time' })
	promo_ends_at?: string | null
}
