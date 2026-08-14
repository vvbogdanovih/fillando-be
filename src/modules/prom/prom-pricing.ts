import { PromDiscount, PromProduct } from './prom.service'

/**
 * Fixed tiered markup (₴) applied on top of the vendor price, ported verbatim from
 * `scripts/AvailabilityCheck/prod/UpdatePriceNicePrice.js`.
 */
const MARKUP_TIERS: ReadonlyArray<{ upTo: number; markup: number }> = [
	{ upTo: 200, markup: 30 },
	{ upTo: 400, markup: 35 },
	{ upTo: 600, markup: 40 },
	{ upTo: 800, markup: 45 },
	{ upTo: 1000, markup: 50 },
	{ upTo: 1500, markup: 100 },
	{ upTo: 2500, markup: 110 }
]

/** Markup for anything above the last tier. */
const TOP_TIER_MARKUP = 120

/** Fixed tiered markup (in ₴) based on the vendor price range. */
export function getMarkupAmount(vendorPrice: number): number {
	return MARKUP_TIERS.find(tier => vendorPrice <= tier.upTo)?.markup ?? TOP_TIER_MARKUP
}

/** Parse Prom's `DD.MM.YYYY` date strings. Returns null for missing/malformed input. */
function parsePromDate(value: string | null | undefined): Date | null {
	if (!value) return null

	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim())
	if (!match) return null

	const [, day, month, year] = match
	const date = new Date(Number(year), Number(month) - 1, Number(day))

	return isNaN(date.getTime()) ? null : date
}

/**
 * Whether the discount applies right now. Prom exposes an inclusive `DD.MM.YYYY` window;
 * a missing bound means "open ended" on that side.
 */
function isDiscountActive(discount: PromDiscount, now: Date): boolean {
	const start = parsePromDate(discount.date_start)
	if (start && now < start) return false

	const end = parsePromDate(discount.date_end)
	if (end) {
		const endOfDay = new Date(end)
		endOfDay.setHours(23, 59, 59, 999)
		if (now > endOfDay) return false
	}

	return true
}

/**
 * Effective vendor price — what the product actually sells for on Prom right now.
 *
 * Prom returns `price` as the pre-discount amount and the reduction separately in `discount`,
 * while the storefront (and the scraper this replaces) shows `price - discount`. So the
 * discount must be subtracted to arrive at the number our markup is built on.
 *
 * Returns null when there is nothing trustworthy to price from — the caller then leaves the
 * variant's price untouched.
 */
export function resolveVendorPrice(product: PromProduct, now = new Date()): number | null {
	const base = product.price

	if (typeof base !== 'number' || !isFinite(base) || base <= 0) return null
	// The markup tiers are denominated in ₴; a non-UAH listing would land in the wrong tier.
	if (product.currency && product.currency !== 'UAH') return null

	const effective = applyDiscount(base, product.discount, now)

	return effective > 0 ? effective : null
}

function applyDiscount(base: number, discount: PromDiscount | null | undefined, now: Date): number {
	if (!discount) return base

	const value = discount.value
	if (typeof value !== 'number' || !isFinite(value) || value <= 0) return base
	if (!isDiscountActive(discount, now)) return base

	return discount.type === 'percent' ? base * (1 - value / 100) : base - value
}

/** Final shop price for a vendor price: tiered markup on top, rounded to whole ₴ — no kopecks. */
export function resolveShopPrice(vendorPrice: number): number {
	return Math.round(vendorPrice + getMarkupAmount(vendorPrice))
}
