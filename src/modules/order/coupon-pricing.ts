/**
 * How a coupon meets a promotion («акція», TD-0012, rule revised by the owner on 2026-10-05).
 *
 * The two never stack. On every line the larger of the two discounts wins, and both are measured
 * from the regular price: a −10 % sale met by a −15 % coupon ends at 15 % off `list_price`, not
 * 15 % off the sale price and not 25 %. A coupon smaller than the sale adds nothing to that line,
 * which keeps the sale price. A line without a promotion has no sale to beat, so it simply takes
 * the coupon percent — the same figure as before the revision.
 *
 * The coupon stays an order-level amount (`applied_discount.discount_amount`): `items[].price`
 * keeps the sale price the line was sold under and `subtotal_price` keeps adding those up, so this
 * module answers only "how much more does the coupon take off". The storefront's
 * `couponDiscountAmount` in `price.utils.ts` is the mirror; keep the two in step.
 */

export interface CouponPricedLine {
	/** What the buyer pays for one unit — the sale price while the promotion is on. */
	price: number
	/** The regular price the coupon is measured from; equals `price` without a promotion. */
	list_price: number
	quantity: number
}

/**
 * The amount the coupon takes off on top of the promotions already in the lines, in hryvnias
 * with two decimals. Zero means the coupon buys nothing — every line is on a sale at least as
 * large — and the caller refuses it rather than burning a single-use code.
 */
export function couponDiscountAmount(lines: readonly CouponPricedLine[], percent: number): number {
	let amount = 0
	for (const line of lines) {
		const couponSaving = (line.list_price * line.quantity * percent) / 100
		const promoSaving = (line.list_price - line.price) * line.quantity
		amount += Math.max(0, couponSaving - promoSaving)
	}
	return Number(amount.toFixed(2))
}
