import { Types } from 'mongoose'
import {
	DeliveryMethod,
	OrderStatus,
	PaymentStatus,
	type StatusActor
} from 'src/common/types/enums'
import type { StatusHistoryEntry } from 'src/database/mongoose/schemas/order.schema'
import { resolvePaymentStatusOnOrderStatusChange } from './payment-status.helpers'

export type { StatusHistoryEntry }

/**
 * The order lifecycle of TD-0011 (fillando-meta, docs/designs/TD-0011-order-status-flow.md).
 *
 * Facts move the status, the admin only decides: a TTN ships the order, Nova Post delivers or
 * returns it, and `COMPLETED` is never chosen by anyone — it is what a delivered order becomes
 * once it is paid (see {@link settleOrderStatus}). Every write of either status goes through
 * {@link planStatusChange}, so the history entry is built by the same code that decides.
 */

export interface StatusState {
	order_status: OrderStatus
	payment_status: PaymentStatus
}

/**
 * What the admin may set by hand, keyed by the current status. Before shipping the three
 * statuses NEW → PROCESSING (buyer contacted, confirmation awaited) → CONFIRMED move freely in
 * either direction, so a misclick is undone with the same dropdown. `DELIVERED` out of them is
 * the pickup handover only — a parcel is delivered by the tracker, or by the admin out of
 * `SHIPPED` when the tracker cannot see it. `COMPLETED` is absent on purpose.
 */
const ADMIN_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
	[OrderStatus.NEW]: [
		OrderStatus.PROCESSING,
		OrderStatus.CONFIRMED,
		OrderStatus.DELIVERED,
		OrderStatus.CANCELLED
	],
	[OrderStatus.PROCESSING]: [
		OrderStatus.NEW,
		OrderStatus.CONFIRMED,
		OrderStatus.DELIVERED,
		OrderStatus.CANCELLED
	],
	[OrderStatus.CONFIRMED]: [
		OrderStatus.NEW,
		OrderStatus.PROCESSING,
		OrderStatus.DELIVERED,
		OrderStatus.CANCELLED
	],
	[OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNING],
	[OrderStatus.DELIVERED]: [OrderStatus.RETURNING],
	[OrderStatus.COMPLETED]: [OrderStatus.RETURNING],
	[OrderStatus.RETURNING]: [OrderStatus.RETURNED, OrderStatus.DELIVERED],
	[OrderStatus.RETURNED]: [],
	[OrderStatus.CANCELLED]: [OrderStatus.NEW]
}

/**
 * Statuses the admin endpoint accepts at all — every target of the table above, so SHIPPED
 * (TTN only) and COMPLETED (derived) are a 400 before any lookup rather than a per-order 409.
 */
export const ADMIN_SETTABLE_ORDER_STATUSES: readonly OrderStatus[] = [
	...new Set(Object.values(ADMIN_TRANSITIONS).flat())
]

/** Not yet handed to the carrier: a TTN entered now ships the order. */
export const PRE_SHIPMENT_ORDER_STATUSES: readonly OrderStatus[] = [
	OrderStatus.NEW,
	OrderStatus.PROCESSING,
	OrderStatus.CONFIRMED
]

const isPreShipment = (status: OrderStatus) => PRE_SHIPMENT_ORDER_STATUSES.includes(status)

/** The transitions the admin may make from here — also what the admin UI renders as buttons. */
export function adminStatusTransitions(order: {
	order_status: OrderStatus
	delivery_method: DeliveryMethod
}): OrderStatus[] {
	// A status this build does not know (a hand-edited document, a value retired without a full
	// backfill) leaves the order readable with no buttons rather than a 500.
	return (ADMIN_TRANSITIONS[order.order_status] ?? []).filter(
		to =>
			!(
				to === OrderStatus.DELIVERED &&
				isPreShipment(order.order_status) &&
				order.delivery_method !== DeliveryMethod.PICKUP
			)
	)
}

/**
 * Whether entering this TTN ships the order: any order that has not left yet, whatever the
 * checkout said about delivery. A TTN *is* the parcel leaving — and in practice a «самовивіз»
 * order often ends up posted anyway (a wholesale buyer paying by invoice, the owner shipping it
 * by Нова Пошта), so judging by `delivery_method` left those orders untracked and never closed.
 * A pickup without a TTN is still handed over by hand («Доставлено» from the dropdown).
 */
export function shipsOnTtn(order: { order_status: OrderStatus }): boolean {
	return isPreShipment(order.order_status)
}

/**
 * `COMPLETED` is «delivered and paid», kept as a stored status so filters and reports can use
 * it, but never chosen: whichever of the two facts arrives second settles it, in the same write.
 * Losing `PAID` (a mistaken click undone, a refund) brings it back to `DELIVERED`.
 */
export function settleOrderStatus(
	orderStatus: OrderStatus,
	paymentStatus: PaymentStatus
): OrderStatus {
	const paid = paymentStatus === PaymentStatus.PAID
	if (orderStatus === OrderStatus.DELIVERED && paid) return OrderStatus.COMPLETED
	if (orderStatus === OrderStatus.COMPLETED && !paid) return OrderStatus.DELIVERED
	return orderStatus
}

export interface StatusChangeOptions {
	adminId?: string
	note?: string
	at?: Date
}

export interface StatusChangePlan {
	order_status: OrderStatus
	payment_status: PaymentStatus
	/** Only the fields that actually change — empty when the request is a no-op. */
	set: Partial<StatusState>
	history: StatusHistoryEntry[]
}

/**
 * The complete effect of asking for a status change: the cross-machine payment rule
 * (TD-0003, extended to `RETURNED`), the `COMPLETED` settlement, and one history entry per
 * field that really moves. Pure — the caller pins its write on the state it read.
 */
export function planStatusChange(
	current: StatusState,
	requested: Partial<StatusState>,
	actor: StatusActor,
	options: StatusChangeOptions = {}
): StatusChangePlan {
	let orderStatus = requested.order_status ?? current.order_status
	let paymentStatus = requested.payment_status ?? current.payment_status

	if (requested.order_status !== undefined && requested.payment_status === undefined) {
		paymentStatus =
			resolvePaymentStatusOnOrderStatusChange(
				current.payment_status,
				current.order_status,
				orderStatus
			) ?? paymentStatus
	}
	orderStatus = settleOrderStatus(orderStatus, paymentStatus)

	const at = options.at ?? new Date()
	const entry = (field: StatusHistoryEntry['field'], from: string, to: string) => {
		const result: StatusHistoryEntry = { field, from, to, at, actor }
		if (options.adminId) result.admin_id = new Types.ObjectId(options.adminId)
		if (options.note) result.note = options.note
		return result
	}

	const set: Partial<StatusState> = {}
	const history: StatusHistoryEntry[] = []
	if (orderStatus !== current.order_status) {
		set.order_status = orderStatus
		history.push(entry('order_status', current.order_status, orderStatus))
	}
	if (paymentStatus !== current.payment_status) {
		set.payment_status = paymentStatus
		history.push(entry('payment_status', current.payment_status, paymentStatus))
	}

	return { order_status: orderStatus, payment_status: paymentStatus, set, history }
}

/** The Mongo update for a plan, plus whatever else the same write carries. */
export function statusChangeUpdate(plan: StatusChangePlan, extraSet: Record<string, unknown> = {}) {
	const $set = { ...extraSet, ...plan.set }
	return plan.history.length > 0
		? { $set, $push: { status_history: { $each: plan.history } } }
		: { $set }
}

/**
 * The history entry for a status change made by a single conditional write, where the state
 * is not read first — the LiqPay retry claim. Used inside an update pipeline, guarded there by
 * the stored value, so it is only appended when the field really moves.
 */
export function statusHistoryEntry(
	field: StatusHistoryEntry['field'],
	from: string,
	to: string,
	actor: StatusActor,
	at: Date = new Date()
): StatusHistoryEntry {
	return { field, from, to, at, actor }
}

/** The first two entries of every order's history, written with the order itself. */
export function initialStatusHistory(
	state: StatusState,
	at: Date = new Date()
): StatusHistoryEntry[] {
	return [
		{ field: 'order_status', from: null, to: state.order_status, at, actor: 'customer' },
		{ field: 'payment_status', from: null, to: state.payment_status, at, actor: 'customer' }
	]
}
