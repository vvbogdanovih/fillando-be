import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

export class GetPriceSheetQueryDto {
	@ApiPropertyOptional({
		example: 'PLA',
		description: 'Search by product name, vendor article, SKU or attribute value'
	})
	@IsOptional()
	@IsString()
	@MaxLength(100)
	q?: string

	@ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number = 1

	@ApiPropertyOptional({ example: 50, default: 50, minimum: 1, maximum: 200 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200)
	limit?: number = 50
}
