import {
	activePromo,
	effectivePriceOf,
	publicPromoFields,
	PromoValidationError,
	resolvePromoPatch,
	salePriceOf
} from './promo-pricing'

const NOW = new Date('2026-10-04T12:00:00.000Z')
const FUTURE = new Date('2026-11-01T00:00:00.000Z')
const PAST = new Date('2026-09-01T00:00:00.000Z')

describe('activePromo', () => {
	it('is null without a percent', () => {
		expect(activePromo({ price: 649 }, NOW)).toBeNull()
		expect(activePromo({ price: 649, promo_percent: null }, NOW)).toBeNull()
	})

	it('runs open-ended when there is no end date', () => {
		expect(activePromo({ price: 649, promo_percent: 15 }, NOW)).toEqual({
			percent: 15,
			ends_at: null,
			sale_price: 552
		})
	})

	it('runs until the end date and not past it', () => {
		const variant = { price: 649, promo_percent: 15, promo_ends_at: FUTURE }
		expect(activePromo(variant, NOW)?.ends_at).toEqual(FUTURE)
		expect(activePromo(variant, FUTURE)).toBeNull()
		expect(activePromo({ ...variant, promo_ends_at: PAST }, NOW)).toBeNull()
	})

	it('accepts the end date as an ISO string too — lean documents and DTOs both reach it', () => {
		expect(
			activePromo({ price: 100, promo_percent: 10, promo_ends_at: FUTURE.toISOString() }, NOW)
		).toMatchObject({ sale_price: 90 })
	})

	it('never discounts a variant with no price — no «−N %» on a 0', () => {
		expect(activePromo({ price: 0, promo_percent: 50 }, NOW)).toBeNull()
	})

	it('rounds to whole hryvnias, half up — the rounding the aggregation twin reproduces', () => {
		// 649 × 0.85 = 551.65 → 552; 250 × 0.85 = 212.5 → 213 (not 212, as $round would give)
		expect(salePriceOf({ price: 649, promo_percent: 15 }, NOW)).toBe(552)
		expect(salePriceOf({ price: 250, promo_percent: 15 }, NOW)).toBe(213)
		expect(salePriceOf({ price: 1000, promo_percent: 90 }, NOW)).toBe(100)
	})

	it('is no promotion when the rounded sale price is not lower than the price, or is nothing', () => {
		// 1 % off 49 ₴ rounds back to 49 — Merchant rejects sale_price ≥ price, and the badge would lie.
		expect(activePromo({ price: 49, promo_percent: 1 }, NOW)).toBeNull()
		expect(activePromo({ price: 40, promo_percent: 1 }, NOW)).toBeNull()
		// 90 % off 3 ₴ rounds to 0 — nothing is sold for nothing.
		expect(activePromo({ price: 3, promo_percent: 90 }, NOW)).toBeNull()
		expect(activePromo({ price: 50, promo_percent: 1 }, NOW)).toBeNull() // 49.5 → 50
		expect(activePromo({ price: 51, promo_percent: 1 }, NOW)).toMatchObject({ sale_price: 50 })
	})
})

describe('effectivePriceOf / publicPromoFields', () => {
	it('is the sale price while on promo and the regular price otherwise', () => {
		expect(effectivePriceOf({ price: 649, promo_percent: 15 }, NOW)).toBe(552)
		expect(effectivePriceOf({ price: 649, promo_percent: 15, promo_ends_at: PAST }, NOW)).toBe(
			649
		)
	})

	it('nulls all three public fields outside a promo, so an expired one reads as none', () => {
		expect(
			publicPromoFields({ price: 649, promo_percent: 15, promo_ends_at: PAST }, NOW)
		).toEqual({ sale_price: null, promo_percent: null, promo_ends_at: null })
		expect(
			publicPromoFields({ price: 649, promo_percent: 15, promo_ends_at: FUTURE }, NOW)
		).toEqual({ sale_price: 552, promo_percent: 15, promo_ends_at: FUTURE })
	})
})

describe('resolvePromoPatch', () => {
	it('stores nothing when the write does not mention the promo', () => {
		expect(resolvePromoPatch({}, { promo_percent: 15 }, NOW)).toEqual({})
	})

	it('clears both fields on null, whatever date came along', () => {
		expect(
			resolvePromoPatch(
				{ promo_percent: null, promo_ends_at: FUTURE.toISOString() },
				null,
				NOW
			)
		).toEqual({ promo_percent: null, promo_ends_at: null })
	})

	it('sets a percent on its own and leaves the date alone', () => {
		expect(resolvePromoPatch({ promo_percent: 20 }, null, NOW)).toEqual({ promo_percent: 20 })
	})

	it('turns the date into a Date and keeps the stored percent', () => {
		expect(
			resolvePromoPatch({ promo_ends_at: FUTURE.toISOString() }, { promo_percent: 15 }, NOW)
		).toEqual({ promo_ends_at: FUTURE })
	})

	it('clears a stale end date when a new percent is set without one — the new promo must run', () => {
		expect(
			resolvePromoPatch(
				{ promo_percent: 25 },
				{ promo_percent: 10, promo_ends_at: PAST },
				NOW
			)
		).toEqual({ promo_percent: 25, promo_ends_at: null })
		// A live end date stays: the admin only changed how much.
		expect(
			resolvePromoPatch(
				{ promo_percent: 25 },
				{ promo_percent: 10, promo_ends_at: FUTURE },
				NOW
			)
		).toEqual({ promo_percent: 25 })
	})

	it('makes an open-ended promo with promo_ends_at: null', () => {
		expect(resolvePromoPatch({ promo_percent: 15, promo_ends_at: null }, null, NOW)).toEqual({
			promo_percent: 15,
			promo_ends_at: null
		})
	})

	it('refuses a date without a percent to apply it to', () => {
		expect(() => resolvePromoPatch({ promo_ends_at: FUTURE.toISOString() }, null, NOW)).toThrow(
			PromoValidationError
		)
		expect(() =>
			resolvePromoPatch({ promo_ends_at: FUTURE.toISOString() }, { promo_percent: null }, NOW)
		).toThrow(expect.objectContaining({ code: 'PROMO_PERCENT_REQUIRED' }))
	})

	it('refuses a date that is not in the future', () => {
		for (const bad of [PAST.toISOString(), NOW.toISOString(), 'not-a-date']) {
			expect(() =>
				resolvePromoPatch({ promo_percent: 10, promo_ends_at: bad }, null, NOW)
			).toThrow(expect.objectContaining({ code: 'PROMO_ENDS_IN_PAST' }))
		}
	})
})
