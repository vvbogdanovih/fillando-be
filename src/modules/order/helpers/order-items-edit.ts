import { Types } from 'mongoose'
import { PaymentStatus } from 'src/common/types/enums'
import type { StatusHistoryEntry } from 'src/database/mongoose/schemas/order.schema'
import { formatPrice } from './format.helpers'

/** One order line as the edit history sees it: what it was and how many. */
export interface ItemsEditLine {
	variant_id: string
	name: string
	quantity: number
}

/**
 * The human line for an `items` edit (FRD §9.2): which lines left, which came, which changed
 * quantity — in that order, so «−PLA ×1; +PETG ×1» reads as the replacement it is. `null`
 * when the two lists are the same lines in the same quantities (order of lines ignored).
 */
export function describeItemsEdit(
	before: readonly ItemsEditLine[],
	after: readonly ItemsEditLine[]
): string | null {
	const beforeById = new Map(before.map(line => [line.variant_id, line]))
	const afterById = new Map(after.map(line => [line.variant_id, line]))
	const parts: string[] = []

	for (const line of before) {
		if (!afterById.has(line.variant_id)) parts.push(`−${line.name} ×${line.quantity}`)
	}
	for (const line of after) {
		if (!beforeById.has(line.variant_id)) parts.push(`+${line.name} ×${line.quantity}`)
	}
	for (const line of after) {
		const was = beforeById.get(line.variant_id)
		if (was && was.quantity !== line.quantity) {
			parts.push(`${line.name}: ${was.quantity} → ${line.quantity} шт.`)
		}
	}

	return parts.length > 0 ? parts.join('; ') : null
}

/**
 * What the money side of an edit means once the buyer has already paid: the order's total is
 * what LiqPay charged (or the admin confirmed), so a different total after the edit is a sum
 * to collect or to give back — outside the system, like a refund. `null` while the order is
 * unpaid (the buyer simply pays the new total) or when the total did not move.
 */
export function describeSettlement(
	paymentStatus: PaymentStatus,
	paidTotal: number,
	newTotal: number
): string | null {
	if (paymentStatus !== PaymentStatus.PAID) return null
	const diff = Number((newTotal - paidTotal).toFixed(2))
	if (diff === 0) return null
	return diff > 0
		? `оплачено ${formatPrice(paidTotal)}, доплата ${formatPrice(diff)}`
		: `оплачено ${formatPrice(paidTotal)}, повернути ${formatPrice(-diff)}`
}

/**
 * The history entry an `items` edit leaves (FRD §9.2): `from`/`to` carry the totals before and
 * after, the note says what changed and — for a paid order — what is left to settle. Written in
 * the same update as the lines themselves, like every status entry (TD-0011).
 */
export function itemsEditHistoryEntry(input: {
	before: readonly ItemsEditLine[]
	after: readonly ItemsEditLine[]
	paymentStatus: PaymentStatus
	totalBefore: number
	totalAfter: number
	adminId?: string
	at?: Date
}): StatusHistoryEntry | null {
	const changes = describeItemsEdit(input.before, input.after)
	if (!changes) return null
	const settlement = describeSettlement(input.paymentStatus, input.totalBefore, input.totalAfter)
	const entry: StatusHistoryEntry = {
		field: 'items',
		from: String(input.totalBefore),
		to: String(input.totalAfter),
		at: input.at ?? new Date(),
		actor: 'admin',
		note: settlement ? `${changes} — ${settlement}` : changes
	}
	if (input.adminId) entry.admin_id = new Types.ObjectId(input.adminId)
	return entry
}
