import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	IsArray,
	IsEnum,
	IsInt,
	IsMongoId,
	IsNumber,
	IsOptional,
	IsString,
	Min,
	Validate,
	ValidateNested
} from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { LandingStatus } from 'src/common/types/enums'
import { IsLandingFiltersConstraint } from './landing-filters.validator'

export class LandingFaqItemDto {
	@ApiProperty({ example: 'Чим PLA Silk відрізняється від звичайного PLA?' })
	@IsString()
	q: string

	@ApiProperty({ example: 'Шовковим блиском поверхні за тих самих температур друку.' })
	@IsString()
	a: string
}

export class CreateLandingDto {
	@ApiProperty(API_PROPERTY.LANDING_CATEGORY_ID)
	@IsMongoId()
	category_id: string

	@ApiProperty(API_PROPERTY.LANDING_SLUG)
	@IsString()
	slug: string

	@ApiProperty(API_PROPERTY.LANDING_H1)
	@IsString()
	h1: string

	@ApiProperty(API_PROPERTY.LANDING_TITLE)
	@IsString()
	title: string

	@ApiProperty(API_PROPERTY.LANDING_META_DESCRIPTION)
	@IsString()
	meta_description: string

	@ApiProperty({ ...API_PROPERTY.LANDING_INTRO_HTML, required: false })
	@IsOptional()
	@IsString()
	intro_html?: string

	@ApiProperty({ ...API_PROPERTY.LANDING_BOTTOM_HTML, required: false })
	@IsOptional()
	@IsString()
	bottom_html?: string

	@ApiProperty({ type: [LandingFaqItemDto], required: false })
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => LandingFaqItemDto)
	faq?: LandingFaqItemDto[]

	@ApiProperty({ ...API_PROPERTY.LANDING_FILTERS, required: false })
	@IsOptional()
	@Validate(IsLandingFiltersConstraint)
	filters?: Record<string, string[]>

	@ApiProperty({ example: 500, required: false, nullable: true })
	@IsOptional()
	@IsNumber()
	@Min(0)
	price_min?: number | null

	@ApiProperty({ example: 1500, required: false, nullable: true })
	@IsOptional()
	@IsNumber()
	@Min(0)
	price_max?: number | null

	@ApiProperty({ example: 'https://cdn.example.com/landings/pla-silk.webp', required: false })
	@IsOptional()
	@IsString()
	image?: string | null

	@ApiProperty({ example: 0, required: false })
	@IsOptional()
	@IsInt()
	@Min(0)
	order?: number

	@ApiProperty({ ...API_PROPERTY.LANDING_STATUS, enum: LandingStatus, required: false })
	@IsOptional()
	@IsEnum(LandingStatus)
	status?: LandingStatus
}
