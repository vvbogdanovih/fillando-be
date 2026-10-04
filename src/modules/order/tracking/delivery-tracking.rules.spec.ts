import { OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { decideTracking, npPhone, type TrackableOrder } from './delivery-tracking.rules'

const order = (overrides: Partial<TrackableOrder> = {}): TrackableOrder => ({
	order_status: OrderStatus.SHIPPED,
	payment_method: PaymentMethod.LIQPAY,
	payment_status: PaymentStatus.PAID,
	...overrides
})

describe('decideTracking — parcel received', () => {
	// The paid → COMPLETED step is planStatusChange's (settleOrderStatus), not the tracker's.
	it.each(['9', '10', '11', '106'])('asks for DELIVERED on code %s', code => {
		expect(decideTracking(order(), code)).toEqual({
			kind: 'update',
			nextStatus: OrderStatus.DELIVERED,
			markPaid: false,
			alert: false
		})
	})

	it.each(['9', '10', '11', '106'])(
		'a received cash-on-delivery parcel is also paid (code %s)',
		code => {
			expect(
				decideTracking(
					order({
						payment_method: PaymentMethod.COD,
						payment_status: PaymentStatus.PENDING
					}),
					code
				)
			).toMatchObject({ kind: 'update', nextStatus: OrderStatus.DELIVERED, markPaid: true })
		}
	)

	it('does not touch a COD payment the admin already settled', () => {
		expect(
			decideTracking(
				order({ payment_method: PaymentMethod.COD, payment_status: PaymentStatus.PAID }),
				'9'
			)
		).toMatchObject({ markPaid: false })
	})

	it.each([PaymentMethod.IBAN, PaymentMethod.LIQPAY, PaymentMethod.CASH])(
		'never marks a %s order paid — receipt says nothing about that money',
		method => {
			expect(
				decideTracking(
					order({ payment_method: method, payment_status: PaymentStatus.PENDING }),
					'9'
				)
			).toMatchObject({ markPaid: false })
		}
	)

	it.each([OrderStatus.NEW, OrderStatus.CONFIRMED, OrderStatus.PROCESSING])(
		'moves a %s order with a TTN written before TD-0011 straight on',
		status => {
			expect(decideTracking(order({ order_status: status }), '9')).toEqual({
				kind: 'update',
				nextStatus: OrderStatus.DELIVERED,
				markPaid: false,
				alert: false
			})
		}
	)

	it.each([OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.RETURNING])(
		'leaves a %s order alone — it is no longer followed',
		status => {
			expect(decideTracking(order({ order_status: status }), '9')).toEqual({ kind: 'none' })
		}
	)
})

describe('decideTracking — parcel not reaching the buyer', () => {
	it.each(['102', '103', '105'])('starts the return and alerts on code %s', code => {
		expect(decideTracking(order(), code)).toEqual({
			kind: 'update',
			nextStatus: OrderStatus.RETURNING,
			markPaid: false,
			alert: true
		})
	})

	it.each(['2', '3'])('only alerts on code %s — the TTN itself looks wrong', code => {
		expect(decideTracking(order(), code)).toEqual({ kind: 'alert' })
	})
})

describe('decideTracking — still on its way', () => {
	it.each(['1', '4', '5', '6', '7', '8', '41', '101', '104', '111', '112'])(
		'does nothing on code %s',
		code => {
			expect(decideTracking(order(), code)).toEqual({ kind: 'none' })
		}
	)
})

describe('npPhone', () => {
	it('keeps digits only', () => {
		expect(npPhone('+38 (067) 000-00-00')).toBe('380670000000')
	})

	it('reads a missing phone as empty', () => {
		expect(npPhone(null)).toBe('')
	})
})
