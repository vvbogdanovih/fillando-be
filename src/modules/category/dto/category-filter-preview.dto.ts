import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	IsArray,
	ArrayMaxSize,
	IsString,
	MaxLength,
	IsNumber,
	ValidateIf,
	ValidateNested
} from 'class-validator'
export class AttributeFilterDto {
	@ApiProperty() @IsString() @MaxLength(100) key!: string
	@ApiPropertyOptional({
		type: 'array',
		maxItems: 100,
		items: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }
	})
	@ValidateIf((_object, value: unknown) => value !== undefined)
	@IsArray()
	@ArrayMaxSize(100)
	values?: (string | number | boolean)[]
	@ApiPropertyOptional()
	@ValidateIf((_object, value: unknown) => value !== undefined)
	@IsNumber()
	min?: number
	@ApiPropertyOptional()
	@ValidateIf((_object, value: unknown) => value !== undefined)
	@IsNumber()
	max?: number
}
export class CategoryFilterPreviewDto {
	@ApiProperty({ type: [AttributeFilterDto], maxItems: 50 })
	@IsArray()
	@ArrayMaxSize(50)
	@ValidateNested({ each: true })
	@Type(() => AttributeFilterDto)
	attributes!: AttributeFilterDto[]
}
export class AttributeFacetValueDto {
	@ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }) value!:
		| string
		| number
		| boolean
	@ApiProperty() count!: number
}
export class AttributeFacetDto {
	@ApiProperty() key!: string
	@ApiProperty({ type: [AttributeFacetValueDto] }) values!: AttributeFacetValueDto[]
	@ApiProperty({ type: Number, nullable: true }) min!: number | null
	@ApiProperty({ type: Number, nullable: true }) max!: number | null
}
export class CategoryFilterPreviewResultDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() total_variants!: number
	@ApiProperty() total_products!: number
	@ApiProperty({ type: [String], maxItems: 50 }) sample_variant_ids!: string[]
	@ApiProperty({ type: [AttributeFacetDto] }) facets!: AttributeFacetDto[]
}
