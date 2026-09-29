import { DeliveryMethod, OrderStatus, PaymentStatus } from 'src/common/types/enums'
import { decideTracking, npPhone, type TrackableOrder } from './delivery-tracking.rules'

const order = (overrides: Partial<TrackableOrder> = {}): TrackableOrder => ({
	order_status: OrderStatus.SHIPPED,
	payment_status: PaymentStatus.PAID,
	delivery_method: DeliveryMethod.NOVA_POST,
	...overrides
})

describe('decideTracking — parcel received', () => {
	it.each(['9', '10', '11', '106'])('closes a paid order on code %s', code => {
		expect(decideTracking(order(), code)).toEqual({
			kind: 'update',
			nextStatus: OrderStatus.COMPLETED
		})
	})

	it('stops an unpaid COD at DELIVERED — its money is still on the way', () => {
		expect(decideTracking(order({ payment_status: PaymentStatus.PENDING }), '10')).toEqual({
			kind: 'update',
			nextStatus: OrderStatus.DELIVERED
		})
	})

	it('closes a DELIVERED order once the admin has marked it paid', () => {
		expect(
			decideTracking(
				order({ order_status: OrderStatus.DELIVERED, payment_status: PaymentStatus.PAID }),
				'11'
			)
		).toEqual({ kind: 'update', nextStatus: OrderStatus.COMPLETED })
	})

	it('leaves a DELIVERED order that is still unpaid as it is', () => {
		expect(
			decideTracking(
				order({
					order_status: OrderStatus.DELIVERED,
					payment_status: PaymentStatus.PENDING
				}),
				'9'
			)
		).toEqual({ kind: 'none' })
	})

	it('moves an order the admin never marked as shipped straight on', () => {
		expect(decideTracking(order({ order_status: OrderStatus.PROCESSING }), '9')).toEqual({
			kind: 'update',
			nextStatus: OrderStatus.COMPLETED
		})
	})
})

describe('decideTracking — parcel not reaching the buyer', () => {
	it.each(['2', '3', '102', '103', '105'])(
		'alerts on code %s without touching the status',
		code => {
			expect(decideTracking(order(), code)).toEqual({ kind: 'alert' })
		}
	)
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
