import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { Color } from 'src/database/mongoose/schemas/color.schema'
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
	'status',
	'color',
	'weight_g'
] as const

export type PublicVariantField = (typeof PUBLIC_VARIANT_FIELDS)[number]

/**
 * The colour of a variant as the storefront needs it: the Ukrainian name it displays, the
 * canonical English one it shows in brackets, the family the filter groups by, and the stops
 * the swatch is painted from (TD-0002 §5.2.2).
 */
export type PublicColor = {
	name_uk: string
	name_en: string
	family: ColorFamily
	hex_stops: string[]
}

/** Allowlist copy of a dictionary colour. Never spread the source. */
export function toPublicColor(
	color: Pick<Color, 'name_uk' | 'name_en' | 'family' | 'hex_stops'> | null | undefined
): PublicColor | null {
	if (!color) return null
	return {
		name_uk: color.name_uk,
		name_en: color.name_en,
		family: color.family,
		hex_stops: color.hex_stops ?? []
	}
}

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
	color: PublicColor | null
	weight_g: number | null
}

/**
 * Explicit allowlist copy of a variant document for public responses. Never spread the
 * source here — a new schema field must not reach the storefront by accident.
 */
export function toPublicVariant(
	variant: ProductVariant & { _id: Types.ObjectId },
	color?: Pick<Color, 'name_uk' | 'name_en' | 'family' | 'hex_stops'> | null
): PublicVariant {
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
		status: variant.status,
		// The dictionary entry, not `color_id`: an internal id is of no use to the storefront,
		// and `v_value` alone turns English after the colour migration (TD-0002 §5.2.2).
		color: toPublicColor(color),
		// Shipping weight is public by design: the delivery estimate and the JSON-LD `weight`
		// are computed from it on the storefront (TD-0006 §5.4).
		weight_g: variant.weight_g ?? null
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
	variant_type: '$product.variant_type',
	// Joined dictionary names. The price sheet keeps `color` a plain string in its response
	// (the storefront validates it as one), so the service formats these two into it.
	// $ifNull, not a bare path: a variant with no dictionary colour would otherwise be missing
	// the keys entirely and the row shape would vary between records.
	color_name_uk: { $ifNull: ['$color.name_uk', null] },
	color_name_en: { $ifNull: ['$color.name_en', null] }
} as const
