import { Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentStatus } from 'src/common/types/enums'
import {
	ADMIN_SETTABLE_ORDER_STATUSES,
	adminStatusTransitions,
	initialStatusHistory,
	planStatusChange,
	settleOrderStatus,
	shipsOnTtn,
	statusChangeUpdate
} from './order-status.rules'

const {
	NEW,
	CONFIRMED,
	PROCESSING,
	SHIPPED,
	DELIVERED,
	COMPLETED,
	RETURNING,
	RETURNED,
	CANCELLED
} = OrderStatus

describe('adminStatusTransitions — the TD-0011 §5.1 table', () => {
	it.each([
		[NEW, DeliveryMethod.NOVA_POST, [PROCESSING, CONFIRMED, CANCELLED]],
		[NEW, DeliveryMethod.PICKUP, [PROCESSING, CONFIRMED, DELIVERED, CANCELLED]],
		[PROCESSING, DeliveryMethod.NOVA_POST, [NEW, CONFIRMED, CANCELLED]],
		[PROCESSING, DeliveryMethod.PICKUP, [NEW, CONFIRMED, DELIVERED, CANCELLED]],
		[CONFIRMED, DeliveryMethod.COURIER, [NEW, PROCESSING, CANCELLED]],
		[CONFIRMED, DeliveryMethod.PICKUP, [NEW, PROCESSING, DELIVERED, CANCELLED]],
		[SHIPPED, DeliveryMethod.NOVA_POST, [DELIVERED, RETURNING]],
		[DELIVERED, DeliveryMethod.NOVA_POST, [RETURNING]],
		[COMPLETED, DeliveryMethod.PICKUP, [RETURNING]],
		[RETURNING, DeliveryMethod.NOVA_POST, [RETURNED, DELIVERED]],
		[RETURNED, DeliveryMethod.NOVA_POST, []],
		[CANCELLED, DeliveryMethod.NOVA_POST, [NEW]]
	])('%s (%s) → %j', (order_status, delivery_method, expected) => {
		expect(adminStatusTransitions({ order_status, delivery_method })).toEqual(expected)
	})

	it('accepts at the endpoint exactly what some row offers — not SHIPPED, not COMPLETED', () => {
		expect([...ADMIN_SETTABLE_ORDER_STATUSES].sort()).toEqual(
			[NEW, PROCESSING, CONFIRMED, DELIVERED, CANCELLED, RETURNING, RETURNED].sort()
		)
	})

	it('offers nothing for a status this build does not know instead of throwing', () => {
		expect(
			adminStatusTransitions({
				order_status: 'ON_HOLD' as OrderStatus,
				delivery_method: DeliveryMethod.NOVA_POST
			})
		).toEqual([])
	})

	it('never offers COMPLETED (derived) or SHIPPED (TTN only)', () => {
		for (const order_status of Object.values(OrderStatus)) {
			for (const delivery_method of Object.values(DeliveryMethod)) {
				const allowed = adminStatusTransitions({ order_status, delivery_method })
				expect(allowed).not.toContain(COMPLETED)
				expect(allowed).not.toContain(SHIPPED)
			}
		}
	})
})

describe('shipsOnTtn', () => {
	it.each([NEW, CONFIRMED, PROCESSING])('ships a carrier order in %s', order_status => {
		expect(shipsOnTtn({ order_status, delivery_method: DeliveryMethod.NOVA_POST })).toBe(true)
	})

	it.each([SHIPPED, DELIVERED, CANCELLED, RETURNING])('keeps %s as it is', order_status => {
		expect(shipsOnTtn({ order_status, delivery_method: DeliveryMethod.NOVA_POST })).toBe(false)
	})

	it('never ships a pickup', () => {
		expect(shipsOnTtn({ order_status: NEW, delivery_method: DeliveryMethod.PICKUP })).toBe(
			false
		)
	})
})

describe('settleOrderStatus — COMPLETED is delivered and paid', () => {
	it('completes a paid delivery', () => {
		expect(settleOrderStatus(DELIVERED, PaymentStatus.PAID)).toBe(COMPLETED)
	})

	it.each([PaymentStatus.PENDING, PaymentStatus.REFUNDED])(
		'takes COMPLETED back to DELIVERED without PAID (%s)',
		payment => {
			expect(settleOrderStatus(COMPLETED, payment)).toBe(DELIVERED)
		}
	)

	it.each([NEW, SHIPPED, RETURNING, CANCELLED])('leaves %s alone even when paid', status => {
		expect(settleOrderStatus(status, PaymentStatus.PAID)).toBe(status)
	})
})

describe('planStatusChange', () => {
	const AT = new Date('2026-10-03T12:00:00.000Z')

	it('applies the cancellation payment rule and records both fields', () => {
		const plan = planStatusChange(
			{ order_status: CONFIRMED, payment_status: PaymentStatus.FAILED },
			{ order_status: CANCELLED },
			'admin',
			{ adminId: '64b8f00000000000000000aa', at: AT }
		)
		expect(plan.set).toEqual({ order_status: CANCELLED, payment_status: PaymentStatus.VOIDED })
		expect(plan.history).toEqual([
			{
				field: 'order_status',
				from: CONFIRMED,
				to: CANCELLED,
				at: AT,
				actor: 'admin',
				admin_id: new Types.ObjectId('64b8f00000000000000000aa')
			},
			{
				field: 'payment_status',
				from: PaymentStatus.FAILED,
				to: PaymentStatus.VOIDED,
				at: AT,
				actor: 'admin',
				admin_id: new Types.ObjectId('64b8f00000000000000000aa')
			}
		])
	})

	it('settles a payment that lands on a delivered order', () => {
		const plan = planStatusChange(
			{ order_status: DELIVERED, payment_status: PaymentStatus.PENDING },
			{ payment_status: PaymentStatus.PAID },
			'gateway'
		)
		expect(plan.set).toEqual({ order_status: COMPLETED, payment_status: PaymentStatus.PAID })
	})

	it('settles a delivery that lands on a paid order', () => {
		const plan = planStatusChange(
			{ order_status: SHIPPED, payment_status: PaymentStatus.PAID },
			{ order_status: DELIVERED },
			'tracker'
		)
		expect(plan.set).toEqual({ order_status: COMPLETED })
		expect(plan.history).toHaveLength(1)
	})

	it('an explicit payment status wins over the cross-machine rule', () => {
		const plan = planStatusChange(
			{ order_status: NEW, payment_status: PaymentStatus.PENDING },
			{ order_status: CANCELLED, payment_status: PaymentStatus.PENDING },
			'system'
		)
		expect(plan.set).toEqual({ order_status: CANCELLED })
	})

	it('plans nothing for a no-op', () => {
		const plan = planStatusChange(
			{ order_status: SHIPPED, payment_status: PaymentStatus.PENDING },
			{ order_status: SHIPPED },
			'admin'
		)
		expect(plan.set).toEqual({})
		expect(plan.history).toEqual([])
		expect(statusChangeUpdate(plan, { nova_post_ttn: '1' })).toEqual({
			$set: { nova_post_ttn: '1' }
		})
	})
})

describe('initialStatusHistory', () => {
	it('opens the history with both statuses from nothing', () => {
		const at = new Date('2026-10-03T00:00:00.000Z')
		expect(
			initialStatusHistory({ order_status: NEW, payment_status: PaymentStatus.PENDING }, at)
		).toEqual([
			{ field: 'order_status', from: null, to: NEW, at, actor: 'customer' },
			{
				field: 'payment_status',
				from: null,
				to: PaymentStatus.PENDING,
				at,
				actor: 'customer'
			}
		])
	})
})
