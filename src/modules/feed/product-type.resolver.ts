import type { FeedAttribute } from './feed.types'

/** The slice of a landing the resolver needs — kept structural so the spec needs no Mongo. */
export interface LandingForProductType {
	category_id: string
	h1: string
	order: number
	filters: Record<string, string[]>
}

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
	landings: LandingForProductType[]
): { product_type: string; landing: LandingForProductType | null } => {
	const candidates = landings
		.filter(l => l.category_id === categoryId && matchesFilters(attributes, l.filters))
		.sort((a, b) => {
			const specificity = Object.keys(b.filters).length - Object.keys(a.filters).length
			return specificity !== 0 ? specificity : a.order - b.order
		})
	const best = candidates[0] ?? null
	return {
		product_type: best ? `${categoryName} > ${best.h1}` : categoryName,
		landing: best
	}
}
