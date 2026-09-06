import { PaymentMethod, PaymentStatus } from 'src/common/types/enums'

/**
 * How long one LiqPay checkout is treated as possibly still live (TD-0009 §5.4.3). While the
 * payment is PENDING a second payload within this window is refused: the first session may yet
 * complete, and two live sessions is how a buyer gets charged twice. A FAILED payment is a
 * session LiqPay itself has closed, so it may be retried at once.
 */
export const LIQPAY_SESSION_COOLDOWN_MS = 15 * 60_000

/**
 * Seconds until a new LiqPay checkout may be opened for the order — the same number the 409
 * carries and the public lookup exposes, so the storefront can show a clock instead of a
 * button that is bound to fail.
 *
 * `null` — not a LiqPay order, or no session was ever opened (pay at once, no waiting);
 * `0` — a session existed but the cooldown has passed or the payment FAILED (pay at once);
 * `n > 0` — wait this many seconds.
 */
export function liqpayRetryAfterSeconds(
	order: {
		payment_method: PaymentMethod
		payment_status: PaymentStatus
		liqpay_checkout_started_at: Date | null
	},
	now: number = Date.now()
): number | null {
	if (order.payment_method !== PaymentMethod.LIQPAY) return null
	if (!order.liqpay_checkout_started_at) return null
	if (order.payment_status !== PaymentStatus.PENDING) return 0
	const remaining =
		LIQPAY_SESSION_COOLDOWN_MS - (now - order.liqpay_checkout_started_at.getTime())
	return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

/** The moment before which a previous session no longer blocks a new one. */
export function liqpaySessionExpiredBefore(now: number = Date.now()): Date {
	return new Date(now - LIQPAY_SESSION_COOLDOWN_MS)
}
