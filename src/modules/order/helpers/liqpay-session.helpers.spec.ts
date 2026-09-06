import { PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { LIQPAY_SESSION_COOLDOWN_MS, liqpayRetryAfterSeconds } from './liqpay-session.helpers'

const NOW = Date.parse('2026-09-06T20:00:00Z')
const order = (overrides: Record<string, unknown> = {}) => ({
	payment_method: PaymentMethod.LIQPAY,
	payment_status: PaymentStatus.PENDING,
	liqpay_checkout_started_at: null as Date | null,
	...overrides
})

describe('liqpayRetryAfterSeconds', () => {
	it('is null when no card session was ever opened — pay at once', () => {
		expect(liqpayRetryAfterSeconds(order(), NOW)).toBeNull()
	})

	it('is null for an order that is not paid by card', () => {
		expect(
			liqpayRetryAfterSeconds(
				order({
					payment_method: PaymentMethod.COD,
					liqpay_checkout_started_at: new Date(NOW)
				}),
				NOW
			)
		).toBeNull()
	})

	it('counts down the cooldown while the payment is still pending', () => {
		const startedAt = new Date(NOW - 2 * 60_000)
		expect(liqpayRetryAfterSeconds(order({ liqpay_checkout_started_at: startedAt }), NOW)).toBe(
			13 * 60
		)
	})

	it('is 0 once the cooldown has passed', () => {
		const startedAt = new Date(NOW - LIQPAY_SESSION_COOLDOWN_MS - 1)
		expect(liqpayRetryAfterSeconds(order({ liqpay_checkout_started_at: startedAt }), NOW)).toBe(
			0
		)
	})

	it('is 0 for a FAILED payment: LiqPay itself closed that session', () => {
		expect(
			liqpayRetryAfterSeconds(
				order({
					payment_status: PaymentStatus.FAILED,
					liqpay_checkout_started_at: new Date(NOW - 60_000)
				}),
				NOW
			)
		).toBe(0)
	})
})
