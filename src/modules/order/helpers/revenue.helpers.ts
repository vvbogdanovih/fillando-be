import { OrderStatus, PaymentStatus } from 'src/common/types/enums'

/**
 * What «not revenue» means, in one place for the sales report and the dashboard.
 *
 * An order in one of these statuses was placed but will bring nothing in: cancelled before
 * shipping, on its way back, or already back. `VOIDED` is written only on those same
 * transitions (`payment-status.helpers.ts`) and `REFUNDED` is the money going back, so the two
 * payment statuses are the same fact seen from the payment side — listed so an order whose
 * status was reopened but whose payment stayed refunded is still not counted as revenue.
 */
export const NON_REVENUE_STATUSES: ReadonlySet<OrderStatus> = new Set([
	OrderStatus.CANCELLED,
	OrderStatus.RETURNING,
	OrderStatus.RETURNED
])

export const NON_REVENUE_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
	PaymentStatus.REFUNDED,
	PaymentStatus.VOIDED
])

export function isNonRevenueOrder(order: {
	order_status: OrderStatus
	payment_status: PaymentStatus
}): boolean {
	return (
		NON_REVENUE_STATUSES.has(order.order_status) ||
		NON_REVENUE_PAYMENT_STATUSES.has(order.payment_status)
	)
}

/** Half-up to kopiykas; `Number.EPSILON` keeps `1.005` from rounding down. */
export function round2(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100
}

export function sum(values: number[]): number {
	return round2(values.reduce((acc, value) => acc + value, 0))
}
