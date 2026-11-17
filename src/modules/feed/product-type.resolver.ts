import { z } from 'zod'
import { attributeFilterSchema, type AttributeFilter } from '../category/category-attribute-filters'
import { parseCatalogFilters } from '../product/public-catalog-query'
import type { FeedAttribute } from './feed.types'

/** The slice of a landing the resolver needs — kept structural so the spec needs no Mongo. */
export interface LandingForProductType {
	category_id: string
	h1: string
	order: number
	/** A v1 landing's pins, matched against the product's attribute rows. */
	filters?: Record<string, string[]>
	/** A typed landing's pins (`filters_v2`), matched against the typed values like the storefront. */
	pins?: AttributeFilter[]
}

/**
 * The pins of a typed landing (`filters_v2`) the feed can evaluate per row — attribute values and
 * numeric ranges — or `null`: a landing that also pins colour families, price, stock, categories,
 * brands or products (or holds nothing valid) never refines `product_type`, rather than type a
 * product the storefront does not list under it.
 */
export function typedLandingPins(filtersV2: unknown): AttributeFilter[] | null {
	try {
		const filters = parseCatalogFilters(filtersV2)
		if (
			filters.category_ids.length ||
			filters.brand_ids.length ||
			filters.color_families.length ||
			filters.product_ids.length ||
			filters.price ||
			filters.in_stock !== undefined
		)
			return null
		const pins = z.array(attributeFilterSchema).parse(filters.attributes)
		return pins.length ? pins : null
	} catch {
		return null
	}
}

/** The storefront's rule: a typed value equal to a pinned one, or a number inside the range. */
const matchesPins = (values: FeedAttribute[], pins: AttributeFilter[]) =>
	pins.every(pin => {
		const own = values.filter(row => row?.k === pin.key).map(row => row.v)
		return 'values' in pin
			? own.some(value => pin.values.some(pinned => pinned === value))
			: own.some(
					value =>
						typeof value === 'number' &&
						(pin.min === undefined || value >= pin.min) &&
						(pin.max === undefined || value <= pin.max)
				)
	})
const specificity = (landing: LandingForProductType) =>
	landing.pins ? landing.pins.length : Object.keys(landing.filters ?? {}).length

const matchesFilters = (attributes: FeedAttribute[], filters: Record<string, string[]>) => {
	const entries = Object.entries(filters ?? {})
	if (entries.length === 0) return false
	return entries.every(([key, values]) =>
		attributes.some(a => a?.k === key && values.includes(String(a.v)))
	)
}

/**
 * `g:product_type` for one variant: "Category > Landing H1" when the product matches every
 * pinned filter of an active landing in its category, else the bare category name.
 *
 * A product can match several landings (PETG Refill → /filament/petg and /filament/refill).
 * The most specific wins — the landing with the most pinned filters — and a tie goes to the
 * lower `order`, the same rule TD-0002 §5.2.3 fixes for the storefront.
 */
export const resolveProductType = (
	categoryName: string,
	categoryId: string,
	attributes: FeedAttribute[],
	landings: LandingForProductType[],
	/** A v2 product's typed values (`attributes_v2` and its SKU's axis value) for typed landings. */
	typedValues: FeedAttribute[] = []
): { product_type: string; landing: LandingForProductType | null } => {
	const candidates = landings
		.filter(
			l =>
				l.category_id === categoryId &&
				(l.pins
					? l.pins.length > 0 && matchesPins(typedValues, l.pins)
					: matchesFilters(attributes, l.filters ?? {}))
		)
		.sort((a, b) => specificity(b) - specificity(a) || a.order - b.order)
	const best = candidates[0] ?? null
	return {
		product_type: best ? `${categoryName} > ${best.h1}` : categoryName,
		landing: best
	}
}
