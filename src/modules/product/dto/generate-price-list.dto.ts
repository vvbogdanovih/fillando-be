import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsMongoId,
	IsNumber,
	IsOptional,
	Max,
	Min
} from 'class-validator'
import { API_PROPERTY } from 'src/common/constants'

export class GeneratePriceListDto {
	@ApiPropertyOptional({ type: [String], ...API_PROPERTY.PRICE_LIST_CATEGORY_IDS })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(200)
	@IsMongoId({ each: true })
	category_ids?: string[]

	@ApiPropertyOptional(API_PROPERTY.PRICE_LIST_IN_STOCK_ONLY)
	@IsOptional()
	@IsBoolean()
	in_stock_only?: boolean = false

	@ApiPropertyOptional(API_PROPERTY.PRICE_LIST_TIER1_PERCENT)
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(0)
	@Max(100)
	tier1_percent?: number = 10

	@ApiPropertyOptional(API_PROPERTY.PRICE_LIST_TIER2_PERCENT)
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(0)
	@Max(100)
	tier2_percent?: number = 15
}
