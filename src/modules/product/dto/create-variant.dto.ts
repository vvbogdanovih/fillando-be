import { ApiProperty } from '@nestjs/swagger'
import { IsArray, IsEnum, IsMongoId, IsNumber, IsOptional, IsString } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { ProductStatus } from 'src/common/types/enums'

export class CreateVariantDto {
	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e1', description: 'Product ObjectId' })
	@IsMongoId()
	product_id: string

	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e2', description: 'Subcategory ObjectId' })
	@IsMongoId()
	subcategory_id: string

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
}
