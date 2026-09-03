import { Types } from 'mongoose'
import { ProductStatus } from 'src/common/types/enums'
import { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'

/**
 * PUBLIC SURFACE — the only variant fields allowed to leave the backend through an
 * unauthenticated endpoint (`GET /products/by-slug/:slug`).
 *
 * Supplier identifiers (`prom_id`, `vendor_product_sku`) and Prom pricing internals
 * (`prom_base_price`, `prom_discount_ratio`, `prom_discount_seen_at`) are deliberately
 * absent: the shop resells at supplier price + margin, so any of them lets a visitor look
 * up the supplier's price and derive the margin. Adding a field here needs a security
 * review (plan-0003, TD-0005).
 */
export const PUBLIC_VARIANT_FIELDS = [
	'id',
	'name',
	'slug',
	'sku',
	'price',
	'price_updated_at',
	'stock',
	'images',
	'v_value',
	'status'
] as const

export type PublicVariantField = (typeof PUBLIC_VARIANT_FIELDS)[number]

export type PublicVariant = {
	id: string
	name: string
	slug: string
	sku: string
	price: number
	price_updated_at: Date | null
	stock: number
	images: string[]
	v_value: string | null
	status: ProductStatus
}

/**
 * Explicit allowlist copy of a variant document for public responses. Never spread the
 * source here — a new schema field must not reach the storefront by accident.
 */
export function toPublicVariant(variant: ProductVariant & { _id: Types.ObjectId }): PublicVariant {
	return {
		id: variant._id.toString(),
		name: variant.name,
		slug: variant.slug,
		sku: variant.sku,
		price: variant.price,
		price_updated_at: variant.price_updated_at ?? null,
		stock: variant.stock,
		images: variant.images ?? [],
		v_value: variant.v_value ?? null,
		status: variant.status
	}
}

/**
 * PUBLIC SURFACE — `$project` stage for the unauthenticated price sheet
 * (`GET /products/price-sheet`). Same rule as {@link PUBLIC_VARIANT_FIELDS}: no supplier
 * identifiers, no `prom_*` pricing internals. Adding a field here needs a security review.
 */
export const PRICE_SHEET_PUBLIC_PROJECTION = {
	_id: 0,
	id: { $toString: '$_id' },
	product_name: '$product.name',
	slug: 1,
	v_value: 1,
	sku: 1,
	price: 1,
	stock: 1,
	stock_updated_at: 1,
	image: { $ifNull: [{ $arrayElemAt: ['$images', 0] }, null] },
	attributes: '$product.attributes',
	variant_type: '$product.variant_type'
} as const
