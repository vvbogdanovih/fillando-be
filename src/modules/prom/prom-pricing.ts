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

/**
 * How long a remembered discount stays usable. A promo the vendor cancelled for good must not
 * keep an out-of-stock variant artificially cheap forever.
 */
export const SNAPSHOT_TTL_DAYS = 60

const DAY_MS = 24 * 60 * 60 * 1000

/** Where the discount used for a price came from. */
export type DiscountSource = 'payload' | 'snapshot' | 'none'

/** The last discount we saw for a variant, as persisted on the variant document. */
export interface DiscountSnapshot {
	ratio: number | null
	seenAt: Date | null
}

export interface ResolvedVendorPrice {
	/** What the product effectively sells for on Prom — the number the markup is built on. */
	vendorPrice: number
	/** Discount as a fraction of the pre-discount base, or null when no discount applied. */
	ratio: number | null
	source: DiscountSource
}

/** Fixed tiered markup (in ₴) based on the vendor price range. */
export function getMarkupAmount(vendorPrice: number): number {
	return MARKUP_TIERS.find(tier => vendorPrice <= tier.upTo)?.markup ?? TOP_TIER_MARKUP
}

/**
 * Prom is a Ukrainian marketplace and its discount windows are plain `DD.MM.YYYY` days in Kyiv
 * time, with no zone attached. Comparing them against a server-local instant is what broke this
 * before: the vendor re-creates its campaign every day with `date_start` set to *today in Kyiv*,
 * so a container running in UTC saw a start date up to three hours in its own future, rejected the
 * discount, and repriced the whole in-stock catalogue off the bare pre-discount amount — roughly
 * +29% — until UTC midnight caught up.
 *
 * So the window is compared as calendar days in the vendor's zone, never as instants.
 */
const VENDOR_TIME_ZONE = 'Europe/Kyiv'

const vendorDayFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: VENDOR_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
})

/** The day an instant falls on in the vendor's zone, as a comparable `YYYYMMDD` number. */
function vendorDay(now: Date): number {
	return Number(vendorDayFormat.format(now).replace(/-/g, ''))
}

/** A Prom `DD.MM.YYYY` bound as a comparable `YYYYMMDD` number, or null if absent/malformed. */
function promDay(value: string | null | undefined): number | null {
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((value ?? '').trim())

	return match ? Number(`${match[3]}${match[2]}${match[1]}`) : null
}

/**
 * Whether the discount applies today. Prom exposes an inclusive day window; a missing or
 * malformed bound means "open ended" on that side.
 */
function isDiscountActive(discount: PromDiscount, now: Date): boolean {
	const today = vendorDay(now)

	const start = promDay(discount.date_start)
	if (start !== null && today < start) return false

	const end = promDay(discount.date_end)
	if (end !== null && today > end) return false

	return true
}

/**
 * Discount as a fraction of `base`, or null when the payload carries nothing applicable.
 *
 * Prom returns `price` as the pre-discount amount and the reduction separately in `discount`,
 * while the storefront shows `price - discount` — so the reduction has to be turned into a
 * ratio of the base before it can be stored or replayed against a base that has since moved.
 */
function ratioFromPayload(
	base: number,
	discount: PromDiscount | null | undefined,
	now: Date
): number | null {
	if (!discount) return null

	const value = discount.value
	if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null
	if (!isDiscountActive(discount, now)) return null

	const ratio = discount.type === 'percent' ? value / 100 : value / base

	return ratio > 0 && ratio < 1 ? ratio : null
}

/** Whether a remembered discount is still recent enough to price from. */
function isSnapshotUsable(snapshot: DiscountSnapshot, now: Date): boolean {
	const { ratio, seenAt } = snapshot

	if (typeof ratio !== 'number' || !isFinite(ratio) || ratio <= 0 || ratio >= 1) return false
	if (!seenAt) return false

	return now.getTime() - new Date(seenAt).getTime() <= SNAPSHOT_TTL_DAYS * DAY_MS
}

/**
 * Effective vendor price — what the product actually sells for on Prom right now.
 *
 * The discount is picked in a way that tells apart the two reasons a payload can arrive without
 * one:
 *
 * - **The promo ended.** Prom still sends the `discount` object, just with a window that has
 *   closed. That is a real price rise, so the bare `price` is used and the remembered discount is
 *   deliberately ignored.
 * - **Prom is withholding it.** The `discount` object disappears entirely once an item goes out
 *   of stock, and the bare `price` it reports is the *pre-discount* amount — pricing off that
 *   inflates the variant by the whole discount (measured at a median +28.7% for this vendor).
 *   Here the remembered ratio is replayed against the current base instead.
 *
 * Returns null when there is nothing trustworthy to price from — the caller then leaves the
 * variant's price untouched.
 */
export function resolveVendorPrice(
	product: PromProduct,
	snapshot: DiscountSnapshot,
	outOfStock: boolean,
	now = new Date()
): ResolvedVendorPrice | null {
	const base = product.price

	if (typeof base !== 'number' || !isFinite(base) || base <= 0) return null
	// The markup tiers are denominated in ₴; a non-UAH listing would land in the wrong tier.
	if (product.currency && product.currency !== 'UAH') return null

	const payloadRatio = ratioFromPayload(base, product.discount, now)

	if (payloadRatio !== null) {
		return { vendorPrice: base * (1 - payloadRatio), ratio: payloadRatio, source: 'payload' }
	}

	// Prom drops the `discount` object entirely for out-of-stock listings. In stock, a missing
	// object means there genuinely is no promo; a *present* object that merely fell outside its
	// window means the promo ended — both are taken at face value.
	if (!product.discount && outOfStock) {
		if (!isSnapshotUsable(snapshot, now)) return null

		const ratio = snapshot.ratio as number
		return { vendorPrice: base * (1 - ratio), ratio, source: 'snapshot' }
	}

	return { vendorPrice: base, ratio: null, source: 'none' }
}

/** Final shop price for a vendor price: tiered markup on top, rounded to whole ₴ — no kopecks. */
export function resolveShopPrice(vendorPrice: number): number {
	return Math.round(vendorPrice + getMarkupAmount(vendorPrice))
}
