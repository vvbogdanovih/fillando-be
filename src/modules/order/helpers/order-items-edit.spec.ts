import { PaymentStatus } from 'src/common/types/enums'
import { describeItemsEdit, describeSettlement, itemsEditHistoryEntry } from './order-items-edit'

describe('describeItemsEdit', () => {
	const pla = { variant_id: 'a', name: 'PLA чорний', quantity: 2 }
	const petg = { variant_id: 'b', name: 'PETG червоний', quantity: 1 }

	it('says what left, what came and what changed quantity — in that order', () => {
		expect(
			describeItemsEdit(
				[pla, { variant_id: 'c', name: 'ABS', quantity: 1 }],
				[petg, { ...pla, quantity: 3 }]
			)
		).toBe('−ABS ×1; +PETG червоний ×1; PLA чорний: 2 → 3 шт.')
	})

	it('is null for the same lines in another order', () => {
		expect(describeItemsEdit([pla, petg], [petg, pla])).toBeNull()
	})
})

describe('describeSettlement', () => {
	it('is null while the order is unpaid — the buyer pays the new total', () => {
		expect(describeSettlement(PaymentStatus.PENDING, 1000, 1200)).toBeNull()
	})

	it('is null when the paid total did not move', () => {
		expect(describeSettlement(PaymentStatus.PAID, 1000, 1000)).toBeNull()
	})

	it('names the surcharge or the refund on a paid order', () => {
		expect(describeSettlement(PaymentStatus.PAID, 1000, 1200)).toMatch(/доплата 200,00 ₴$/)
		expect(describeSettlement(PaymentStatus.PAID, 1000, 850.5)).toMatch(/повернути 149,50 ₴$/)
	})
})

describe('itemsEditHistoryEntry', () => {
	it('carries the totals as from/to and no entry for a no-op', () => {
		const line = { variant_id: 'a', name: 'PLA', quantity: 1 }
		expect(
			itemsEditHistoryEntry({
				before: [line],
				after: [line],
				paymentStatus: PaymentStatus.PAID,
				totalBefore: 500,
				totalAfter: 500
			})
		).toBeNull()
		expect(
			itemsEditHistoryEntry({
				before: [line],
				after: [{ ...line, quantity: 2 }],
				paymentStatus: PaymentStatus.PENDING,
				totalBefore: 500,
				totalAfter: 1000
			})
		).toMatchObject({
			field: 'items',
			from: '500',
			to: '1000',
			actor: 'admin',
			note: 'PLA: 1 → 2 шт.'
		})
	})
})
