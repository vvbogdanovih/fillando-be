import { ApiProperty } from '@nestjs/swagger'
import {
	IsArray,
	IsEnum,
	IsInt,
	IsISO8601,
	IsMongoId,
	IsNumber,
	IsOptional,
	IsString,
	Matches,
	Max,
	Min,
	ValidateIf
} from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { ProductStatus } from 'src/common/types/enums'
import { PROMO_PERCENT_MAX, PROMO_PERCENT_MIN } from '../promo-pricing'

export class UpdateVariantDto {
	@ApiProperty({ example: 'Футболка базова — Чорна', required: false })
	@IsOptional()
	@IsString()
	name?: string

	@ApiProperty({ example: 440, required: false })
	@IsOptional()
	@IsNumber()
	price?: number

	@ApiProperty({ example: 100, required: false })
	@IsOptional()
	@IsNumber()
	stock?: number

	@ApiProperty({ type: [String], required: false })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	images?: string[]

	@ApiProperty({ example: 'Чорна', nullable: true, required: false })
	@IsOptional()
	@IsString()
	v_value?: string | null

	@ApiProperty({ example: 'VENDOR-SKU-123', required: false })
	@IsOptional()
	@IsString()
	vendor_product_sku?: string

	@ApiProperty({ example: '3012625429', required: false })
	@IsOptional()
	@IsString()
	prom_id?: string

	@ApiProperty({ enum: ProductStatus, required: false })
	@IsOptional()
	@IsEnum(ProductStatus)
	status?: ProductStatus

	@ApiProperty({
		example: '69b7c630ff27ba94157052dd',
		description: 'Colour dictionary entry; null clears it',
		nullable: true,
		required: false
	})
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@IsMongoId()
	color_id?: string | null

	@ApiProperty({
		example: 1220,
		description:
			'Shipping weight in grams — filament plus the spool when one is included. Feeds the delivery estimate and the Google Shopping feed; null clears it',
		nullable: true,
		required: false
	})
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@IsInt()
	@Min(0)
	weight_g?: number | null

	@ApiProperty({ ...API_PROPERTY.PROMO_PERCENT, nullable: true, required: false })
	@IsOptional()
	@IsInt()
	@Min(PROMO_PERCENT_MIN)
	@Max(PROMO_PERCENT_MAX)
	promo_percent?: number | null

	@ApiProperty({ ...API_PROPERTY.PROMO_ENDS_AT, nullable: true, required: false })
	@IsOptional()
	@IsISO8601()
	// A date-only value would be read as UTC midnight — 02:00 in Kyiv — and end the sale almost a
	// day early; the admin form always sends a full timestamp, so the API insists on one.
	@Matches(/^\d{4}-\d{2}-\d{2}T/, { message: 'promo_ends_at must be an ISO 8601 date-time' })
	promo_ends_at?: string | null
}

export class AddVariantDto {
	@ApiProperty({ example: 440, description: 'Variant price' })
	@IsNumber()
	price: number

	@ApiProperty({
		example: 'Чорна',
		description: 'Variant distinguishing value; omit for single-variant products',
		nullable: true,
		required: false
	})
	@IsOptional()
	@IsString()
	v_value?: string | null

	@ApiProperty({ example: 100, required: false })
	@IsOptional()
	@IsNumber()
	stock?: number

	@ApiProperty({ type: [String], required: false })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	images?: string[]

	@ApiProperty({ example: 'VENDOR-SKU-123', required: false })
	@IsOptional()
	@IsString()
	vendor_product_sku?: string

	@ApiProperty({ example: '3012625429', required: false })
	@IsOptional()
	@IsString()
	prom_id?: string

	@ApiProperty({ enum: ProductStatus, default: ProductStatus.ACTIVE, required: false })
	@IsOptional()
	@IsEnum(ProductStatus)
	status?: ProductStatus

	@ApiProperty({
		example: '69b7c630ff27ba94157052dd',
		description: 'Colour dictionary entry; null clears it',
		nullable: true,
		required: false
	})
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@IsMongoId()
	color_id?: string | null

	@ApiProperty({
		example: 1220,
		description:
			'Shipping weight in grams — filament plus the spool when one is included. Feeds the delivery estimate and the Google Shopping feed; null clears it',
		nullable: true,
		required: false
	})
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@IsInt()
	@Min(0)
	weight_g?: number | null

	@ApiProperty({ ...API_PROPERTY.PROMO_PERCENT, nullable: true, required: false })
	@IsOptional()
	@IsInt()
	@Min(PROMO_PERCENT_MIN)
	@Max(PROMO_PERCENT_MAX)
	promo_percent?: number | null

	@ApiProperty({ ...API_PROPERTY.PROMO_ENDS_AT, nullable: true, required: false })
	@IsOptional()
	@IsISO8601()
	// A date-only value would be read as UTC midnight — 02:00 in Kyiv — and end the sale almost a
	// day early; the admin form always sends a full timestamp, so the API insists on one.
	@Matches(/^\d{4}-\d{2}-\d{2}T/, { message: 'promo_ends_at must be an ISO 8601 date-time' })
	promo_ends_at?: string | null
}
