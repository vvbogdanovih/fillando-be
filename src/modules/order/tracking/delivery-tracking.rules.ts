import { OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'

/**
 * Nova Post `TrackingDocument.getStatusDocuments` status codes the tracker acts on. The API
 * returns them as strings; the full list is longer (in transit, at the branch, re-addressed…)
 * and every other code means «still on its way» — the order is left alone.
 */
export const NP_RECEIVED_CODES = new Set([
	'9', // Відправлення отримано
	'10', // Отримано; протягом доби — SMS про грошовий переказ (накладений платіж)
	'11', // Отримано, грошовий переказ видано
	'106' // Одержано і створено ЄН зворотної доставки
])

/** The parcel is not going to the buyer: it moves the order to RETURNING and the admin is told. */
export const NP_RETURN_CODES = new Set([
	'102', // Відмова від отримання
	'103', // Відмова одержувача
	'105' // Припинено зберігання — посилка їде назад
])

/** The TTN itself looks wrong: only the admin can tell what happened, so they are told and nothing moves. */
export const NP_ISSUE_CODES = new Set([
	'2', // Видалено
	'3' // Номер не знайдено — найчастіше помилка в ТТН
])

/**
 * Statuses a parcel can be in transit from. A TTN ships the order (TD-0011), so after the
 * migration only SHIPPED carries one; the pre-shipment statuses cover orders written before it.
 * DELIVERED is no longer followed — a paid delivered order settles to COMPLETED in the write
 * that marks it paid, not on the next pass.
 */
export const TRACKED_ORDER_STATUSES: OrderStatus[] = [
	OrderStatus.NEW,
	OrderStatus.CONFIRMED,
	OrderStatus.PROCESSING,
	OrderStatus.SHIPPED
]

/** Parcels are followed this long after the order; an older one is the admin's to chase. */
export const TRACKING_WINDOW_DAYS = 60

export interface TrackableOrder {
	order_status: OrderStatus
	payment_method: PaymentMethod
	payment_status: PaymentStatus
}

/**
 * `update` asks for an order status, and for a cash-on-delivery parcel also for the payment: the
 * buyer pays at the counter to get it, so «received» is the payment fact too, and the write
 * runs through `planStatusChange`, which turns a paid DELIVERED into COMPLETED. For every other
 * payment method the tracker leaves the payment alone. `alert` means the admin gets the one-off
 * delivery-issue email.
 */
export type TrackingDecision =
	| { kind: 'update'; nextStatus: OrderStatus; markPaid: boolean; alert: boolean }
	| { kind: 'alert' }
	| { kind: 'none' }

/**
 * What one tracking result means for its order. Pure, so the cron's behaviour is the table the
 * tests spell out rather than something read back from a live parcel.
 */
export function decideTracking(order: TrackableOrder, statusCode: string): TrackingDecision {
	if (!TRACKED_ORDER_STATUSES.includes(order.order_status)) return { kind: 'none' }
	if (NP_RECEIVED_CODES.has(statusCode)) {
		const markPaid =
			order.payment_method === PaymentMethod.COD &&
			order.payment_status === PaymentStatus.PENDING
		return { kind: 'update', nextStatus: OrderStatus.DELIVERED, markPaid, alert: false }
	}
	if (NP_RETURN_CODES.has(statusCode)) {
		return { kind: 'update', nextStatus: OrderStatus.RETURNING, markPaid: false, alert: true }
	}
	if (NP_ISSUE_CODES.has(statusCode)) return { kind: 'alert' }
	return { kind: 'none' }
}

/** Nova Post matches the recipient's phone as bare digits; a wrong one only hides the details. */
export function npPhone(phone: string | null | undefined): string {
	return (phone ?? '').replace(/\D/g, '')
}
