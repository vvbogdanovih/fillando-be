import { DeliveryMethod, OrderStatus, PaymentStatus } from 'src/common/types/enums'

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

/** Codes an admin must look at: the parcel is not going to the buyer, or the TTN is wrong. */
export const NP_ISSUE_CODES = new Set([
	'2', // Видалено
	'3', // Номер не знайдено — найчастіше помилка в ТТН
	'102', // Відмова від отримання
	'103', // Відмова одержувача
	'105' // Припинено зберігання — посилка їде назад
])

/** Statuses a parcel can be in transit from. Later ones are the admin's, or already final. */
export const TRACKED_ORDER_STATUSES: OrderStatus[] = [
	OrderStatus.NEW,
	OrderStatus.CONFIRMED,
	OrderStatus.PROCESSING,
	OrderStatus.SHIPPED,
	// A received COD parcel waits here for its money; once the admin marks it PAID the next
	// pass closes it, so nobody has to come back for the second click.
	OrderStatus.DELIVERED
]

/** Parcels are followed this long after the order; an older one is the admin's to chase. */
export const TRACKING_WINDOW_DAYS = 60

export interface TrackableOrder {
	order_status: OrderStatus
	payment_status: PaymentStatus
	delivery_method: DeliveryMethod
}

/**
 * The order status a received parcel moves the order to. Paid means closed; unpaid — a COD whose
 * transfer from Nova Post has not been confirmed yet — stops at DELIVERED, so the report never
 * shows an order as completed while its money is still on the way.
 */
export function receivedOrderStatus(order: TrackableOrder): OrderStatus {
	return order.payment_status === PaymentStatus.PAID
		? OrderStatus.COMPLETED
		: OrderStatus.DELIVERED
}

export type TrackingDecision =
	| { kind: 'update'; nextStatus: OrderStatus }
	| { kind: 'alert' }
	| { kind: 'none' }

/**
 * What one tracking result means for its order. Pure, so the cron's behaviour is the table the
 * tests spell out rather than something read back from a live parcel.
 */
export function decideTracking(order: TrackableOrder, statusCode: string): TrackingDecision {
	if (NP_RECEIVED_CODES.has(statusCode)) {
		const nextStatus = receivedOrderStatus(order)
		return nextStatus === order.order_status ? { kind: 'none' } : { kind: 'update', nextStatus }
	}
	if (NP_ISSUE_CODES.has(statusCode)) return { kind: 'alert' }
	return { kind: 'none' }
}

/** Nova Post matches the recipient's phone as bare digits; a wrong one only hides the details. */
export function npPhone(phone: string | null | undefined): string {
	return (phone ?? '').replace(/\D/g, '')
}
