import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

export type FilterType = 'multi-select' | 'range'

export class RequiredAttributeDto {
	@ApiProperty({ example: 'Виробник', description: 'Attribute label (human-readable)' })
	@IsString()
	label: string

	@ApiProperty({
		example: 'multi-select',
		enum: ['multi-select', 'range'],
		description: 'Filter UI type'
	})
	@IsEnum(['multi-select', 'range'])
	filter_type: FilterType

	@ApiProperty({ example: 'мм', description: 'Unit of measure', nullable: true })
	@IsOptional()
	@IsString()
	unit: string | null
}

export class CreateCategoryDto {
	@ApiProperty(API_PROPERTY.CATEGORY_NAME)
	@IsString()
	name: string

	@ApiProperty(API_PROPERTY.SLUG)
	@IsString()
	slug: string

	@ApiProperty(API_PROPERTY.CATEGORY_IMAGE)
	@IsOptional()
	@IsString()
	image?: string

	@ApiProperty(API_PROPERTY.CATEGORY_ORDER)
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
