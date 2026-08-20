import type { AttrLike } from '../product-attribute.helpers'

/** One variant row as it comes out of `ProductVariantRepository.findPriceListRows`. */
export interface PriceListRawRow {
	product_id: string
	product_name: string
	attributes?: AttrLike[]
	variant_type?: { key?: string; label?: string } | null
	variant_name: string
	v_value?: string | null
	sku: string
	price: number
	stock?: number
}

/** One rendered table row. */
export interface PriceListRow {
	sku: string
	color: string
	stock: number
	price: number
	price_tier1: number
	price_tier2: number
}

/**
 * A run of rows sharing one merged product-name cell. A product with many variants is
 * split into several blocks so a `rowspan` never straddles a page break — see
 * `MAX_ROWS_PER_BLOCK` in price-list.service.ts.
 */
export interface PriceListBlock {
	product_name: string
	is_continuation: boolean
	rows: PriceListRow[]
}

export interface PriceListData {
	generatedAt: Date
	landscape: boolean
	tier1Percent: number
	tier2Percent: number
	inStockOnly: boolean
	categoryNames: string[]
	totalRows: number
	logoDataUri: string | null
	blocks: PriceListBlock[]
}
