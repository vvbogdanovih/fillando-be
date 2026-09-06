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

/** The payment states in which the buyer may still switch the payment method (TD-0009 §5.4.1). */
export const PAYMENT_METHOD_CHANGEABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
	PaymentStatus.PENDING,
	PaymentStatus.FAILED
]

/**
 * The fulfilment states in which the buyer may still switch the payment method. From PROCESSING
 * on the parcel may already carry a COD invoice, so only the admin changes it after that.
 */
export const PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES: readonly OrderStatus[] = [
	OrderStatus.NEW,
	OrderStatus.CONFIRMED
]

export function canCustomerChangePaymentMethod(order: {
	payment_status: PaymentStatus
	order_status: OrderStatus
}): boolean {
	return (
		PAYMENT_METHOD_CHANGEABLE_PAYMENT_STATUSES.includes(order.payment_status) &&
		PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES.includes(order.order_status)
	)
}

/**
 * Payment status after the buyer switches the payment method (TD-0009 §5.4.1).
 *
 * `FAILED` describes one declined card attempt; an order now paid by IBAN, COD or cash is
 * simply awaiting payment again, so it goes back to `PENDING`. `PENDING` is already right.
 * Terminal states never reach this function — `canCustomerChangePaymentMethod` refuses first.
 *
 * @returns the new payment status, or `null` when payment must stay untouched.
 */
export function resolvePaymentStatusOnPaymentMethodChange(
	currentPaymentStatus: PaymentStatus
): PaymentStatus | null {
	return currentPaymentStatus === PaymentStatus.FAILED ? PaymentStatus.PENDING : null
}
