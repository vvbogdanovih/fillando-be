import { OrderStatus, PaymentStatus } from 'src/common/types/enums'

/**
 * Cross-machine rule between `order_status` and `payment_status`.
 *
 * Cancelling an order that was never paid must not leave it reading
 * "Очікує оплату" forever, so the payment moves to a terminal `VOIDED`.
 * A `PAID` order keeps its status — the money really arrived and an admin has
 * to refund it manually and set `REFUNDED` afterwards.
 *
 * Documented in docs/architecture/state-machines.md (fillando-meta) and TD-0003.
 *
 * @returns the new payment status, or `null` when payment must stay untouched.
 */
export function resolvePaymentStatusOnOrderStatusChange(
	currentPaymentStatus: PaymentStatus,
	currentOrderStatus: OrderStatus,
	nextOrderStatus: OrderStatus
): PaymentStatus | null {
	if (nextOrderStatus === OrderStatus.CANCELLED) {
		// Re-applying CANCELLED is intentionally handled too: it heals legacy
		// orders cancelled before VOIDED existed and never backfilled.
		const isUnpaid =
			currentPaymentStatus === PaymentStatus.PENDING ||
			currentPaymentStatus === PaymentStatus.FAILED
		return isUnpaid ? PaymentStatus.VOIDED : null
	}

	// Reaching here means nextOrderStatus is not CANCELLED, so an order that was
	// cancelled is being reopened: the payment is expected again.
	if (
		currentOrderStatus === OrderStatus.CANCELLED &&
		currentPaymentStatus === PaymentStatus.VOIDED
	) {
		return PaymentStatus.PENDING
	}

	return null
}
