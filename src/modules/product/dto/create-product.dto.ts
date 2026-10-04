import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	IsArray,
	IsDefined,
	IsInt,
	IsISO8601,
	IsMongoId,
	IsNumber,
	IsObject,
	IsOptional,
	IsString,
	Matches,
	Max,
	Min,
	ValidateIf,
	ValidateNested
} from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { PROMO_PERCENT_MAX, PROMO_PERCENT_MIN } from '../promo-pricing'

export class VariantTypeDto {
	@ApiProperty({ example: 'color', description: 'Variant type key' })
	@IsString()
	key: string

	@ApiProperty({ example: 'Color', description: 'Variant type label' })
	@IsString()
	label: string
}

export class ProductDescriptionDto {
	@ApiProperty({ example: { ops: [{ insert: 'Hello' }] }, description: 'Quill delta JSON' })
	@IsObject()
	json: Record<string, unknown>

	@ApiProperty({ example: '<p>Hello</p>', description: 'Rendered HTML' })
	@IsString()
	html: string
}

export class AttributeDto {
	@ApiProperty({ example: 'Виробник', description: 'Attribute label (human-readable)' })
	@IsString()
	l: string

	@ApiProperty({ example: 'Sony', description: 'Attribute value (string, number, or boolean)' })
	@IsDefined()
	v: string | number | boolean
}

export class CreateVariantDto {
	@ApiProperty({
		example: 'Червоний',
		description: 'Variant distinguishing value (null for single-variant products)',
		nullable: true,
		required: false
	})
	@IsOptional()
	@IsString()
	v_value?: string | null

	@ApiProperty({ example: 440, description: 'Price in minor units or base currency' })
	@IsNumber()
	price: number

	@ApiProperty({ example: 100, description: 'Available stock quantity', required: false })
	@IsOptional()
	@IsNumber()
	stock?: number

	@ApiProperty({ type: [String], description: 'Image URLs', required: false })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	images?: string[]

	@ApiProperty({ example: 'VENDOR-SKU-123', description: 'Vendor-assigned SKU', required: false })
	@IsOptional()
	@IsString()
	vendor_product_sku?: string

	@ApiProperty({
		example: '3012625429',
		description: 'Prom (npshop) product id taken from the product URL',
		required: false
	})
	@IsOptional()
	@IsString()
	prom_id?: string

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

export class CreateProductDto {
	@ApiProperty(API_PROPERTY.PRODUCT_NAME)
	@IsString()
	name: string

	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e1', description: 'Category ObjectId' })
	@IsMongoId()
	category_id: string

	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e3', description: 'Vendor ObjectId' })
	@IsMongoId()
	vendor_id: string

	@ApiProperty({ type: ProductDescriptionDto, required: false })
	@IsOptional()
	@ValidateNested()
	@Type(() => ProductDescriptionDto)
	description?: ProductDescriptionDto

	@ApiProperty({ type: VariantTypeDto, required: false })
	@IsOptional()
	@ValidateNested()
	@Type(() => VariantTypeDto)
	variant_type?: VariantTypeDto

	@ApiProperty({ type: [AttributeDto], required: false })
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => AttributeDto)
	attributes?: AttributeDto[]

	@ApiProperty({ type: [CreateVariantDto], required: false })
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => CreateVariantDto)
	variants?: CreateVariantDto[]
}
