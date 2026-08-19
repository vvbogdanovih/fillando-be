import { OrderStatus, PaymentStatus } from 'src/common/types/enums'
import { resolvePaymentStatusOnOrderStatusChange } from './payment-status.helpers'

describe('resolvePaymentStatusOnOrderStatusChange', () => {
	describe('cancelling an order', () => {
		it('voids a payment that is still pending', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.PENDING,
					OrderStatus.NEW,
					OrderStatus.CANCELLED
				)
			).toBe(PaymentStatus.VOIDED)
		})

		it('voids a payment that failed', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.FAILED,
					OrderStatus.CONFIRMED,
					OrderStatus.CANCELLED
				)
			).toBe(PaymentStatus.VOIDED)
		})

		it('leaves a paid order alone so an admin can refund it manually', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.PAID,
					OrderStatus.PROCESSING,
					OrderStatus.CANCELLED
				)
			).toBeNull()
		})

		it('leaves an already refunded payment alone', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.REFUNDED,
					OrderStatus.PROCESSING,
					OrderStatus.CANCELLED
				)
			).toBeNull()
		})

		it('heals a legacy cancelled order that was never backfilled', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.PENDING,
					OrderStatus.CANCELLED,
					OrderStatus.CANCELLED
				)
			).toBe(PaymentStatus.VOIDED)
		})
	})

	describe('reopening a cancelled order', () => {
		it('expects payment again', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.VOIDED,
					OrderStatus.CANCELLED,
					OrderStatus.CONFIRMED
				)
			).toBe(PaymentStatus.PENDING)
		})

		it('does not resurrect a payment that was actually made', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.PAID,
					OrderStatus.CANCELLED,
					OrderStatus.CONFIRMED
				)
			).toBeNull()
		})
	})

	describe('every other transition', () => {
		it('leaves the payment status untouched', () => {
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.PENDING,
					OrderStatus.NEW,
					OrderStatus.CONFIRMED
				)
			).toBeNull()
			expect(
				resolvePaymentStatusOnOrderStatusChange(
					PaymentStatus.PAID,
					OrderStatus.SHIPPED,
					OrderStatus.DELIVERED
				)
			).toBeNull()
		})
	})
})
