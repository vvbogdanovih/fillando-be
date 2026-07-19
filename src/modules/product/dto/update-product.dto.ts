import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsMongoId, IsOptional, IsString, ValidateNested } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { AttributeDto, ProductDescriptionDto, VariantTypeDto } from './create-product.dto'

export class UpdateProductDto {
	@ApiProperty({ ...API_PROPERTY.PRODUCT_NAME, required: false })
	@IsOptional()
	@IsString()
	name?: string

	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e1', required: false })
	@IsOptional()
	@IsMongoId()
	category_id?: string

	@ApiProperty({ example: '64b1f2c3d4e5f6a7b8c9d0e3', required: false })
	@IsOptional()
	@IsMongoId()
	vendor_id?: string

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
}
