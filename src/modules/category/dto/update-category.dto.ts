import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { RequiredAttributeDto } from './create-category.dto'

export class UpdateCategoryDto {
	@ApiProperty({ ...API_PROPERTY.CATEGORY_NAME, required: false })
	@IsOptional()
	@IsString()
	name?: string

	@ApiProperty({ ...API_PROPERTY.SLUG, required: false })
	@IsOptional()
	@IsString()
	slug?: string

	@ApiProperty({ ...API_PROPERTY.CATEGORY_IMAGE, required: false })
	@IsOptional()
	@IsString()
	image?: string

	@ApiProperty({ ...API_PROPERTY.CATEGORY_ORDER, required: false })
	@IsOptional()
	@IsInt()
	@Min(0)
	order?: number

	@ApiProperty({ type: [RequiredAttributeDto], required: false })
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => RequiredAttributeDto)
	required_attributes?: RequiredAttributeDto[]
}
