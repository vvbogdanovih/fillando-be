import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'
import { Type } from 'class-transformer'

export class SearchProductsDto {
	@ApiProperty({ example: 'PLA', description: 'Search query (min 2, max 100 characters)' })
	@IsString()
	@MinLength(2)
	@MaxLength(100)
	q: string

	@ApiProperty({ example: 1, description: 'Page number', required: false, default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number = 1

	@ApiProperty({
		example: 20,
		description: 'Items per page (max 100)',
		required: false,
		default: 20
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number = 20
}
