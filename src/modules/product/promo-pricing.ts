/**
 * Promotional discounts («акція», TD-0012) — the one place that decides what a shopper pays.
 *
 * The promo lives beside the price, never in it: `ProductVariant.price` is rewritten every
 * 30 minutes by the Prom sync (supplier price + markup), so a sale folded into `price` would be
 * undone within the half hour. `promo_percent` / `promo_ends_at` survive the sync, and the sale
 * price is derived from them on every read — by the JS rules below for documents already in
 * memory, and by the aggregation twins below for the catalogue pipeline, which has to filter
 * and sort on it inside MongoDB. The two halves are kept in parity by
 * `product-variant-promo.int-spec.ts`; change one and the other.
 *
 * Nothing here is stored. An expired promo is simply inactive — the fields stay on the
 * document for the admin to see, and every public surface reads them as "no promo".
 */

export const PROMO_PERCENT_MIN = 1
export const PROMO_PERCENT_MAX = 90

export interface PromoSource {
	price: number
	promo_percent?: number | null
	promo_ends_at?: Date | string | null
}

export interface ActivePromo {
	percent: number
	ends_at: Date | null
	sale_price: number
}

/** The three fields every public variant carries; all null without an active promo. */
export interface PublicPromoFields {
	sale_price: number | null
	promo_percent: number | null
	promo_ends_at: Date | null
}

function toDate(value: Date | string | null | undefined): Date | null {
	if (value == null) return null
	const date = value instanceof Date ? value : new Date(value)
	return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Whole hryvnias, half up — `Math.round` for a positive number. Spelled out as floor(x + 0.5)
 * because that is the form the aggregation twin can reproduce: MongoDB's `$round` rounds half to
 * even, and 212.5 would be 213 on the page but 212 in the catalogue filter.
 */
export function roundSalePrice(value: number): number {
	return Math.floor(value + 0.5)
}

/**
 * The promo in force right now, or null. Active means: a percent is set, the end date — when
 * there is one — has not passed, and the rounded sale price really is a sale: above zero and
 * below the regular price. Merchant rejects a `sale_price` that is not lower than `price`, and a
 * «−1 %» badge over an unchanged figure is a lie, so a percent that rounds away is no promotion.
 */
export function activePromo(variant: PromoSource, now: Date = new Date()): ActivePromo | null {
	const percent = variant.promo_percent
	if (percent == null || !(variant.price > 0)) return null
	const endsAt = toDate(variant.promo_ends_at)
	if (endsAt && endsAt.getTime() <= now.getTime()) return null
	const salePrice = roundSalePrice(variant.price * (1 - percent / 100))
	if (!(salePrice > 0) || salePrice >= variant.price) return null
	return { percent, ends_at: endsAt, sale_price: salePrice }
}

export function salePriceOf(variant: PromoSource, now?: Date): number | null {
	return activePromo(variant, now)?.sale_price ?? null
}

/** What the buyer pays right now. */
export function effectivePriceOf(variant: PromoSource, now?: Date): number {
	return activePromo(variant, now)?.sale_price ?? variant.price
}

export function publicPromoFields(variant: PromoSource, now?: Date): PublicPromoFields {
	const promo = activePromo(variant, now)
	return promo
		? {
				sale_price: promo.sale_price,
				promo_percent: promo.percent,
				promo_ends_at: promo.ends_at
			}
		: { sale_price: null, promo_percent: null, promo_ends_at: null }
}

// ---------------------------------------------------------------------------------------------
// Aggregation twins. `now` defaults to `$$NOW` so a const projection stays const; specs pass a
// Date for determinism. Field paths are the variant's own, so these only work on a stage where
// the variant is the root document.
// ---------------------------------------------------------------------------------------------

/** floor(price × (1 − p/100) + 0.5) — the same half-up rounding as {@link roundSalePrice}. */
const roundedSaleExpr = {
	$floor: {
		$add: [
			{ $multiply: ['$price', { $subtract: [1, { $divide: ['$promo_percent', 100] }] }] },
			0.5
		]
	}
}

export const promoActiveExpr = (now: unknown = '$$NOW') => ({
	$and: [
		{ $ne: [{ $ifNull: ['$promo_percent', null] }, null] },
		{ $gt: ['$price', 0] },
		{
			$or: [
				{ $eq: [{ $ifNull: ['$promo_ends_at', null] }, null] },
				{ $gt: ['$promo_ends_at', now] }
			]
		},
		// A sale that rounds to the regular price, or to nothing, is not a sale (see activePromo).
		{ $gt: [roundedSaleExpr, 0] },
		{ $lt: [roundedSaleExpr, '$price'] }
	]
})

export const salePriceExpr = (now?: unknown) => ({
	$cond: [promoActiveExpr(now), roundedSaleExpr, null]
})

export const effectivePriceExpr = (now?: unknown) => ({ $ifNull: [salePriceExpr(now), '$price'] })

/** Spread into a `$project` / `$addFields`: the public trio, nulled when inactive. */
export const publicPromoProjection = (now?: unknown) => ({
	sale_price: salePriceExpr(now),
	promo_percent: { $cond: [promoActiveExpr(now), '$promo_percent', null] },
	// `$ifNull`, not a bare path: a document that never had the field would otherwise lose the
	// key entirely, and the row shape would differ from the JS mapper's.
	promo_ends_at: { $cond: [promoActiveExpr(now), { $ifNull: ['$promo_ends_at', null] }, null] }
})

// ---------------------------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------------------------

export interface PromoWriteInput {
	promo_percent?: number | null
	promo_ends_at?: string | Date | null
}

export type PromoPatch = { promo_percent?: number | null; promo_ends_at?: Date | null }

export class PromoValidationError extends Error {
	constructor(
		readonly code: 'PROMO_PERCENT_REQUIRED' | 'PROMO_ENDS_IN_PAST',
		message: string
	) {
		super(message)
	}
}

/**
 * What a write may store, given what the caller mentioned and what the variant already has.
 * Mirrors the ES2023 rule used throughout `ProductService`: a field the client never sent is
 * `undefined` and means "leave it"; `null` means "clear".
 *
 * - nothing mentioned → `{}`
 * - `promo_percent: null` → both cleared (clearing wins over any date sent alongside)
 * - a date while the resulting percent is null → `PROMO_PERCENT_REQUIRED`
 * - a date that is not in the future → `PROMO_ENDS_IN_PAST`
 * - `promo_ends_at: null` → open-ended
 * - a new percent while the stored end date has passed → that date is cleared too
 */
export function resolvePromoPatch(
	input: PromoWriteInput,
	existing: { promo_percent: number | null; promo_ends_at?: Date | null } | null,
	now: Date = new Date()
): PromoPatch {
	if (input.promo_percent === undefined && input.promo_ends_at === undefined) return {}
	if (input.promo_percent === null) return { promo_percent: null, promo_ends_at: null }

	const percent = input.promo_percent ?? existing?.promo_percent ?? null
	const patch: PromoPatch = {}
	if (input.promo_percent !== undefined) {
		patch.promo_percent = input.promo_percent
		// A new percent on a variant whose previous promotion has already ended: the stale end
		// date would make the new promotion inactive from its first second. It is cleared unless
		// the write names a date of its own.
		const storedEnd = toDate(existing?.promo_ends_at)
		if (
			input.promo_ends_at === undefined &&
			storedEnd &&
			storedEnd.getTime() <= now.getTime()
		) {
			patch.promo_ends_at = null
		}
	}

	if (input.promo_ends_at !== undefined) {
		if (input.promo_ends_at === null) {
			patch.promo_ends_at = null
		} else {
			if (percent === null) {
				throw new PromoValidationError(
					'PROMO_PERCENT_REQUIRED',
					'Дата завершення акції без відсотка не має сенсу — вкажіть відсоток знижки'
				)
			}
			const endsAt = toDate(input.promo_ends_at)
			if (!endsAt || endsAt.getTime() <= now.getTime()) {
				throw new PromoValidationError(
					'PROMO_ENDS_IN_PAST',
					'Дата завершення акції має бути в майбутньому'
				)
			}
			patch.promo_ends_at = endsAt
		}
	}
	return patch
}
