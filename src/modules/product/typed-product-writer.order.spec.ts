import { keepStoredOrder } from './typed-product-writer'

describe('keepStoredOrder', () => {
	it('keeps stored keys in place and appends new ones in the validated order', () => {
		expect(
			keepStoredOrder(
				[{ k: 'material' }, { k: 'gone' }, { k: 'polymer' }],
				[
					{ k: 'polymer', v: 'PLA' },
					{ k: 'series', v: 'Basic' },
					{ k: 'material', v: 'PLA' },
					{ k: 'finish', v: 'Silk' }
				]
			).map(row => row.k)
		).toEqual(['material', 'polymer', 'series', 'finish'])
	})

	it('falls back to the validated order without a stored list', () => {
		const next = [{ k: 'b' }, { k: 'a' }]
		expect(keepStoredOrder(undefined, next)).toEqual(next)
		expect(keepStoredOrder('broken', next)).toEqual(next)
	})
})
