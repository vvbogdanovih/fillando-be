import { couponDiscountAmount } from './coupon-pricing'

// The same figures live in the storefront's price.utils.test.ts — the two previews must agree.
describe('couponDiscountAmount', () => {
	const plain = { price: 500, list_price: 500, quantity: 1 }
	// 600 at −10 %: sale 540, the promotion already saves 60 a unit.
	const onSale = { price: 540, list_price: 600, quantity: 2 }

	it('takes the full percent off a line without a promotion', () => {
		expect(couponDiscountAmount([plain], 10)).toBe(50)
	})

	it('adds nothing to a promo line the coupon does not beat', () => {
		expect(couponDiscountAmount([onSale], 10)).toBe(0)
		expect(couponDiscountAmount([onSale], 5)).toBe(0)
	})

	it('lifts a promo line to the coupon percent of the regular price when the coupon is larger', () => {
		// 15 % of 2 × 600 is 180; the sale already gave 120, so the coupon adds 60.
		expect(couponDiscountAmount([onSale], 15)).toBe(60)
	})

	it('sums the lines: each one keeps the larger of its two discounts', () => {
		expect(couponDiscountAmount([onSale, plain], 10)).toBe(50)
		expect(couponDiscountAmount([onSale, plain], 15)).toBe(135)
	})

	it('measures a sale rounded to whole hryvnias from the regular price, so the line ends at exactly the coupon percent', () => {
		// 599 at −10 % rounds to 539 (saving 60, not 59.9); 15 % of 599 is 89.85 → adds 29.85.
		expect(couponDiscountAmount([{ price: 539, list_price: 599, quantity: 1 }], 15)).toBe(29.85)
	})

	it('answers two decimals and zero for an empty order', () => {
		expect(couponDiscountAmount([{ price: 333, list_price: 333, quantity: 3 }], 7)).toBe(69.93)
		expect(couponDiscountAmount([], 15)).toBe(0)
	})
})
