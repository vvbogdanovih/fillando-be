import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Min } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

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
}
