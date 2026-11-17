import { ApiProperty } from '@nestjs/swagger'

export class PriceSheetItemDto {
	@ApiProperty() id: string
	@ApiProperty() slug: string
	@ApiProperty({ type: String, nullable: true }) image: string | null
	@ApiProperty() name: string
	@ApiProperty({ description: 'The SKU category; its columns are in `categories`' })
	category_id: string
	@ApiProperty({
		type: 'object',
		additionalProperties: { type: 'string' },
		description:
			'Text per characteristic column of the category (`categories[].columns[].key`), with the unit; a column without a value is absent'
	})
	values: Record<string, string>
	@ApiProperty({ type: String, nullable: true }) manufacturer: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		deprecated: true,
		description:
			'Legacy «Матеріал» label match of a v1 category; null for a typed one — read `values`'
	})
	material: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'Actual colour only, never an arbitrary variant value'
	})
	color: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'Display value of the variant, including non-colour axes'
	})
	variant_label: string | null
	@ApiProperty({ type: String, nullable: true }) article: string | null
	@ApiProperty() price: number
	@ApiProperty({ type: Number, nullable: true }) sale_price: number | null
	@ApiProperty({ type: Number, nullable: true }) promo_percent: number | null
	@ApiProperty({ type: String, format: 'date-time', nullable: true }) promo_ends_at: string | null
	@ApiProperty() in_stock: boolean
	@ApiProperty() stock: number
	@ApiProperty({ type: String, format: 'date-time', nullable: true }) synced_at: string | null
}
export class PriceSheetColumnDto {
	@ApiProperty() key: string
	@ApiProperty() label: string
}
export class PriceSheetCategoryDto {
	@ApiProperty() id: string
	@ApiProperty() name: string
	@ApiProperty({
		type: [PriceSheetColumnDto],
		description:
			'The characteristics the catalogue filters this category by, colour included, in its order; empty for a v1 category'
	})
	columns: PriceSheetColumnDto[]
	@ApiProperty({
		description:
			'Show the «Варіант» column (`variant_label ?? color`): a variation of this page’s rows that no column shows — a v1 category, or an axis that is not a filter'
	})
	variant_column: boolean
}
export class PriceSheetResponseDto {
	@ApiProperty({ type: [PriceSheetItemDto] }) items: PriceSheetItemDto[]
	@ApiProperty({
		type: [PriceSheetCategoryDto],
		description: 'The categories of this page’s rows, in row order'
	})
	categories: PriceSheetCategoryDto[]
	@ApiProperty() total: number
	@ApiProperty() page: number
	@ApiProperty() limit: number
}
