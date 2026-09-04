import { ApiProperty } from '@nestjs/swagger'
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	Matches,
	Min
} from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'
import { ColorFamily } from 'src/common/types/enums'

/** Uppercase or lowercase, but always the full six digits — shorthand would break gradients. */
export const HEX_STOP_PATTERN = /^#[0-9a-fA-F]{6}$/

export class CreateColorDto {
	@ApiProperty(API_PROPERTY.COLOR_NAME_EN)
	@IsString()
	name_en: string

	@ApiProperty(API_PROPERTY.COLOR_NAME_UK)
	@IsString()
	name_uk: string

	@ApiProperty({ ...API_PROPERTY.SLUG, required: false })
	@IsOptional()
	@IsString()
	slug?: string

	@ApiProperty({ ...API_PROPERTY.COLOR_FAMILY, enum: ColorFamily })
	@IsEnum(ColorFamily)
	family: ColorFamily

	@ApiProperty({ ...API_PROPERTY.COLOR_HEX_STOPS, type: [String] })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(6)
	@Matches(HEX_STOP_PATTERN, { each: true, message: 'each hex stop must look like #RRGGBB' })
	hex_stops: string[]

	@ApiProperty({ ...API_PROPERTY.COLOR_ORDER, required: false })
	@IsOptional()
	@IsInt()
	@Min(0)
	order?: number
}
