import { ApiProperty } from '@nestjs/swagger'
import { IsArray, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator'
import { ProductStatus } from 'src/common/types/enums'

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
}
