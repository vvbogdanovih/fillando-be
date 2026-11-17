import { ApiProperty } from '@nestjs/swagger'
import { AttributeFacetDto } from '../../category/dto/category-filter-preview.dto'
export class PublicTypedAttributeDto {
	@ApiProperty() k!: string
	@ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }) v!:
		| string
		| number
		| boolean
}
export class PublicItemColorDto {
	@ApiProperty() name_uk!: string
	@ApiProperty() name_en!: string
	@ApiProperty() family!: string
	@ApiProperty({ type: [String] }) hex_stops!: string[]
}
export class ColorFamilyFacetDto {
	@ApiProperty() family!: string
	@ApiProperty() count!: number
	@ApiProperty({ type: [String] }) hex_stops!: string[]
}
export class PublicCatalogItemDto {
	@ApiProperty() id!: string
	@ApiProperty() product_id!: string
	@ApiProperty() category_id!: string
	@ApiProperty() name!: string
	@ApiProperty() slug!: string
	@ApiProperty() sku!: string
	@ApiProperty() price!: number
	@ApiProperty() stock!: number
	@ApiProperty({ type: String, format: 'date-time', nullable: true }) price_updated_at!:
		| string
		| null
	@ApiProperty({ type: String, nullable: true }) v_value!: string | null
	@ApiProperty({
		oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
		nullable: true
	})
	variant_value!: string | number | boolean | null
	@ApiProperty({ type: [PublicTypedAttributeDto] }) attributes_v2!: PublicTypedAttributeDto[]
	@ApiProperty({ type: String, nullable: true }) brand_id!: string | null
	@ApiProperty({ type: String, nullable: true }) main_image!: string | null
	@ApiProperty({ type: PublicItemColorDto, nullable: true }) color!: PublicItemColorDto | null
	@ApiProperty({ type: Number, nullable: true }) sale_price!: number | null
	@ApiProperty({ type: Number, nullable: true }) promo_percent!: number | null
	@ApiProperty({ type: String, format: 'date-time', nullable: true }) promo_ends_at!:
		| string
		| null
}
export class CatalogStripSwatchDto {
	@ApiProperty({ type: String, nullable: true }) family!: string | null
	@ApiProperty({ type: [String] }) hex_stops!: string[]
	@ApiProperty({ description: 'A SKU of this colour can be bought now' }) in_stock!: boolean
}
/** What the product's SKUs under the strip's scope and filters add to its first one. */
export class CatalogStripGroupDto {
	@ApiProperty({ description: 'The product name, without the SKU value' }) name!: string
	@ApiProperty({ description: 'Active SKUs of the product under the scope and filters' })
	count!: number
	@ApiProperty() in_stock!: number
	@ApiProperty({ description: 'How many of them are on a live promotion' }) on_sale!: number
	@ApiProperty({ description: 'Effective price over the in-stock SKUs; over all when none is' })
	price_min!: number
	@ApiProperty() price_max!: number
	@ApiProperty({ description: 'Distinct dictionary colours of those SKUs' }) colors_count!: number
	@ApiProperty({ type: [CatalogStripSwatchDto], description: 'At most 12, in-stock first' })
	colors!: CatalogStripSwatchDto[]
}
export class CatalogStripItemDto extends PublicCatalogItemDto {
	@ApiProperty({ type: CatalogStripGroupDto }) group!: CatalogStripGroupDto
}
/** A product strip: one card per product (owner, 2026-11-14). */
export class CatalogStripResponseDto {
	@ApiProperty() revision!: number
	@ApiProperty({ type: [CatalogStripItemDto] }) items!: CatalogStripItemDto[]
}
export class CatalogCountDto {
	@ApiProperty() id!: string
	@ApiProperty() label!: string
	@ApiProperty() count!: number
}
export class CatalogPriceBoundsDto {
	@ApiProperty({ type: Number, nullable: true }) min!: number | null
	@ApiProperty({ type: Number, nullable: true }) max!: number | null
}
export class CatalogStockCountsDto {
	@ApiProperty() true!: number
	@ApiProperty() false!: number
}
export class PublicCatalogFacetsDto {
	@ApiProperty({ type: [AttributeFacetDto] }) attributes!: AttributeFacetDto[]
	@ApiProperty({ type: [CatalogCountDto] }) categories!: CatalogCountDto[]
	@ApiProperty({ type: [CatalogCountDto] }) brands!: CatalogCountDto[]
	@ApiProperty({ type: CatalogPriceBoundsDto }) price!: CatalogPriceBoundsDto
	@ApiProperty({ type: CatalogStockCountsDto }) in_stock!: CatalogStockCountsDto
	@ApiProperty({
		type: [ColorFamilyFacetDto],
		description: 'Only for a product category with a colour-semantic axis; empty otherwise'
	})
	colors!: ColorFamilyFacetDto[]
}
export class PublicCatalogResponseDto {
	@ApiProperty() revision!: number
	@ApiProperty() page!: number
	@ApiProperty() limit!: number
	@ApiProperty() total!: number
	@ApiProperty({ type: [PublicCatalogItemDto] }) items!: PublicCatalogItemDto[]
	@ApiProperty({ type: PublicCatalogFacetsDto }) facets!: PublicCatalogFacetsDto
}

export class CatalogCategoryCountDto {
	@ApiProperty() id!: string
	@ApiProperty({ description: 'Active SKUs of the category' }) count!: number
}
/** Non-empty visible product categories of the whole catalogue (Plan-0010 D06.5). */
export class CatalogCategoryCountsDto {
	@ApiProperty() revision!: number
	@ApiProperty({ type: [CatalogCategoryCountDto], description: 'Non-empty only, by id' })
	categories!: CatalogCategoryCountDto[]
	@ApiProperty({ type: String, nullable: true }) next_cursor!: string | null
}
