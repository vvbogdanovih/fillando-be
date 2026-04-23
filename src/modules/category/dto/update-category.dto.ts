import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Min } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

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
}
