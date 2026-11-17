import type { AttrLike } from '../product-attribute.helpers'
import type { PriceColumn } from '../price-columns'

/** One variant row as it comes out of `ProductVariantRepository.findPriceListRows`. */
export interface PriceListRawRow {
	product_id: string
	category_id?: string
	product_name: string
	attributes?: AttrLike[]
	/** A v2 row's brand, set by the service (entity or `brand` characteristic); v1 has none. */
	brand?: string | null
	variant_type?: { key?: string; label?: string } | null
	/** Typed fields of a v2 product (TD-0013); turned into `attributes` by the service. */
	attributes_v2?: { k: string; v: unknown }[] | null
	variant_axis?: { key: string } | null
	variant_value?: unknown
	brand_name?: string | null
	/** The SKU's dictionary colour, joined. */
	color_name_uk?: string | null
	color_name_en?: string | null
	variant_name: string
	v_value?: string | null
	sku: string
	price: number
	stock?: number
}

/** One rendered table row. */
export interface PriceListRow {
	sku: string
	variant_label: string
	/** Text per characteristic column (`priceValuesOf`); the block shows its axis column per row. */
	values: Record<string, string>
	stock: number
	price: number
}

/**
 * A run of rows of one product: its name and every product-level characteristic are one merged
 * cell, the axis column (and «Варіант») one cell per SKU. A product with many variants is split
 * into several blocks so a `rowspan` never straddles a page break — see `MAX_ROWS_PER_BLOCK` in
 * price-list.service.ts.
 */
export interface PriceListBlock {
	product_name: string
	is_continuation: boolean
	/** The product's axis key: that column is printed per SKU, the others merged. */
	axis_key: string | null
	rows: PriceListRow[]
}

/** One category: its own table, with the columns its catalogue filters by (owner, 2026-11-06). */
export interface PriceListSection {
	category_name: string
	columns: PriceColumn[]
	/** A «Варіант» column per SKU, for a variation the characteristic columns do not show. */
	variant_column: boolean
	blocks: PriceListBlock[]
}

export interface PriceListData {
	generatedAt: Date
	landscape: boolean
	inStockOnly: boolean
	categoryNames: string[]
	totalRows: number
	logoDataUri: string | null
	sections: PriceListSection[]
}
