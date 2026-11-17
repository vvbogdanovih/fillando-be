import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsString,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested
} from 'class-validator'
export class DefinitionOptionInputDto {
	@ApiPropertyOptional()
	@ValidateIf((_object, value: unknown) => value !== undefined)
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	id?: string
	@ApiProperty() @IsString() @MinLength(1) @MaxLength(200) label!: string
	@ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) order!: number
}
export class AttributeDefinitionInputDto {
	@ApiPropertyOptional({
		description: 'Omit for additions; existing keys must belong to the target category'
	})
	@ValidateIf((_object, value: unknown) => value !== undefined)
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	key?: string
	@ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) label!: string
	@ApiProperty({ enum: ['string', 'number', 'boolean', 'enum'] })
	@IsIn(['string', 'number', 'boolean', 'enum'])
	value_type!: 'string' | 'number' | 'boolean' | 'enum'
	@ApiProperty({ type: String, nullable: true })
	@ValidateIf((_object, value: unknown) => value !== null)
	@IsString()
	@MinLength(1)
	@MaxLength(50)
	unit!: string | null
	@ApiProperty({ enum: ['multi-select', 'range'], nullable: true })
	@ValidateIf((_object, value: unknown) => value !== null)
	@IsIn(['multi-select', 'range'])
	filter_type!: 'multi-select' | 'range' | null
	@ApiProperty({ enum: ['generic', 'color', 'size', 'material', 'brand'] })
	@IsIn(['generic', 'color', 'size', 'material', 'brand'])
	semantic!: 'generic' | 'color' | 'size' | 'material' | 'brand'
	@ApiProperty({}) @IsBoolean() is_required!: boolean
	@ApiProperty({}) @IsBoolean() filter_enabled!: boolean
	@ApiProperty({}) @IsBoolean() visible_in_specs!: boolean
	@ApiProperty({}) @IsBoolean() multiple!: boolean
	@ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) order!: number
	@ApiProperty({ type: [DefinitionOptionInputDto], maxItems: 200 })
	@IsArray()
	@ArrayMaxSize(200)
	@ValidateNested({ each: true })
	@Type(() => DefinitionOptionInputDto)
	options!: DefinitionOptionInputDto[]
}
export class DefinitionOptionDto extends DefinitionOptionInputDto {
	@ApiProperty() declare id: string
}
export class AttributeDefinitionDto extends AttributeDefinitionInputDto {
	@ApiProperty() declare key: string
	@ApiProperty({ type: [DefinitionOptionDto] }) declare options: DefinitionOptionDto[]
}
export class CategoryDefinitionsDto {
	@ApiProperty({ minimum: 0 })
	@IsInt()
	@Min(0)
	@Max(Number.MAX_SAFE_INTEGER)
	expected_revision!: number
	@ApiProperty({ type: [AttributeDefinitionInputDto], maxItems: 100 })
	@IsArray()
	@ArrayMaxSize(100)
	@ValidateNested({ each: true })
	@Type(() => AttributeDefinitionInputDto)
	definitions!: AttributeDefinitionInputDto[]
}
export class CategoryControlsDto {
	@ApiProperty({ type: [AttributeDefinitionDto] }) fields!: AttributeDefinitionDto[]
	@ApiProperty({ type: [AttributeDefinitionDto] }) filters!: AttributeDefinitionDto[]
	@ApiProperty({ type: [AttributeDefinitionDto] }) specs!: AttributeDefinitionDto[]
	@ApiProperty({ type: [String] }) variant_axes!: string[]
}
export class CategoryConfigurationDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty({ enum: ['group', 'product'] }) kind!: string
	@ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: string
	@ApiProperty({ type: [AttributeDefinitionDto] }) definitions!: AttributeDefinitionDto[]
	@ApiProperty({ type: CategoryControlsDto }) controls!: CategoryControlsDto
}
export class OptionUsageDto {
	@ApiProperty() id!: string
	@ApiProperty() products!: number
	@ApiProperty() variants!: number
	@ApiProperty() landings!: number
}
export class KeyUsageDto {
	@ApiProperty() key!: string
	@ApiProperty({ description: 'Products holding a value (as a characteristic or their axis)' })
	products!: number
	@ApiProperty({ description: 'SKUs holding a value (axis)' }) variants!: number
	@ApiProperty({
		description: 'Typed landings pinning it (colour families count for the colour axis)'
	})
	landings!: number
	@ApiProperty({ description: 'Landings pinning it as an attribute filter' }) pins!: number
	@ApiProperty({ description: 'Products of the category without a value' }) missing!: number
	@ApiProperty({ type: [OptionUsageDto] }) options!: OptionUsageDto[]
}
export class DefinitionUsageDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() published!: boolean
	@ApiProperty({ description: 'Products of the category' }) products!: number
	@ApiProperty({ type: [KeyUsageDto] }) keys!: KeyUsageDto[]
}
