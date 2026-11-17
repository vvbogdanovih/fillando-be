import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { CategoryAncestorDto } from './category-public.dto'

/**
 * Page size of the category cursor reads — tree, children, options, ancestors (Plan-0010 D06):
 * the default and the ceiling. The storefront walks at the ceiling (`CATEGORY_TREE_PAGE_MAX` in
 * fillando-fe); lowering it is an API change.
 */
export const CATEGORY_PAGE = { default: 200, max: 1000 } as const

export class CategoryTreeQueryDto {
	@ApiPropertyOptional({
		type: 'integer',
		default: CATEGORY_PAGE.default,
		minimum: 1,
		maximum: CATEGORY_PAGE.max
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(CATEGORY_PAGE.max)
	limit?: number

	@ApiPropertyOptional({
		maxLength: 2048,
		description:
			'Opaque cursor from the preceding page; bound to snapshot revision and audience'
	})
	@IsOptional()
	@IsString()
	@MaxLength(2048)
	cursor?: string
}
export class CategoryTreeItemDto {
	@ApiPropertyOptional({ enum: [1, 2], description: 'ADMIN only' })
	attribute_contract_version?: number
	@ApiPropertyOptional({ type: String, nullable: true, description: 'ADMIN only: tile image' })
	image?: string | null
	@ApiProperty() _id: string
	@ApiProperty({ type: String, nullable: true }) parent_id: string | null
	@ApiProperty({ enum: ['group', 'product'] }) kind: 'group' | 'product'
	@ApiProperty({ enum: ['draft', 'active', 'archived'] }) status: 'draft' | 'active' | 'archived'
	@ApiProperty() name: string
	@ApiProperty() slug: string
	@ApiProperty() order: number
}
export class CategoryTreePageDto {
	@ApiProperty() revision: number
	@ApiProperty({ type: [CategoryTreeItemDto] }) items: CategoryTreeItemDto[]
	@ApiProperty({ type: String, nullable: true }) next_cursor: string | null
}

/** One product category in a select (Plan-0010 D06): what a list needs, not the content. */
export class CategoryOptionDto {
	@ApiProperty() _id: string
	@ApiProperty() name: string
	@ApiProperty() slug: string
	@ApiProperty({ enum: ['product'] }) kind: 'product'
	@ApiProperty({ enum: [1, 2] }) attribute_contract_version: 1 | 2
	@ApiProperty() order: number
	@ApiProperty({ type: String, nullable: true }) image: string | null
	@ApiProperty({
		description: 'Characteristics: v1 required_attributes or v2 attribute_definitions'
	})
	attribute_count: number
}
export class CategoryOptionsPageDto {
	@ApiProperty() revision: number
	@ApiProperty({ type: [CategoryOptionDto] }) items: CategoryOptionDto[]
	@ApiProperty({ type: String, nullable: true }) next_cursor: string | null
}

export class CategoryAncestorsPageDto {
	@ApiProperty() revision: number
	@ApiProperty({ description: 'Ancestors in the whole path' }) total: number
	@ApiProperty({ type: [CategoryAncestorDto], description: 'Root first' })
	items: CategoryAncestorDto[]
	@ApiProperty({ type: String, nullable: true }) next_cursor: string | null
}

export class CategoryChildrenQueryDto extends CategoryTreeQueryDto {
	@ApiPropertyOptional({ description: 'Parent category ID; omit to list roots' })
	@IsOptional()
	@IsMongoId()
	parent_id?: string
}
