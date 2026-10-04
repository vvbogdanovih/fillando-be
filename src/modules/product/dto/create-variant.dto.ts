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

export class CreateVariantDto {
	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e1', description: 'Product ObjectId' })
	@IsMongoId()
	product_id: string

	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e2', description: 'Category ObjectId' })
	@IsMongoId()
	category_id: string

	@ApiProperty({ example: 'Футболка базова — Чорна', description: 'Full variant name' })
	@IsString()
	name: string

	@ApiProperty(API_PROPERTY.SLUG)
	@IsString()
	slug: string

	@ApiProperty({ example: 799.99, description: 'Variant price' })
	@IsNumber()
	price: number

	@ApiProperty({
		example: 'Чорна',
		description: 'Variant value; null if product has no variants',
		required: false
	})
	@IsOptional()
	@IsString()
	v_value?: string

	@ApiProperty({ example: 10, description: 'Stock count', required: false })
	@IsOptional()
	@IsNumber()
	stock?: number

	@ApiProperty({ example: ['https://cdn.example.com/img.webp'], required: false })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	images?: string[]

	@ApiProperty({
		example: 'NP-SKU-001',
		description: 'Vendor product SKU for NicePrice',
		required: false
	})
	@IsOptional()
	@IsString()
	vendor_product_sku?: string

	@ApiProperty({ enum: ProductStatus, default: ProductStatus.ACTIVE, required: false })
	@IsOptional()
	@IsEnum(ProductStatus)
	status?: ProductStatus

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
