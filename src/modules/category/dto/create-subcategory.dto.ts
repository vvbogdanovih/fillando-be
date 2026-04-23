import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator'
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

export class CreateSubcategoryDto {
	@ApiProperty({ example: 'Smartphones', description: 'Subcategory name' })
	@IsString()
	name: string

	@ApiProperty(API_PROPERTY.SLUG)
	@IsString()
	slug: string

	@ApiProperty({ type: [RequiredAttributeDto], required: false })
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => RequiredAttributeDto)
	required_attributes?: RequiredAttributeDto[]
}
