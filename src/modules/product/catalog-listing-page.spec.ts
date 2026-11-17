import { mongo } from 'mongoose'
import { pageSegments, slicePriced, withTies, type PricedId } from './catalog-listing-page'

const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
const priced = (n: number, key: number | null): PricedId => ({ _id: id(n), key })

describe('pageSegments', () => {
	it('covers the in-stock run, then the sold-out run, as one sort would', () => {
		expect(pageSegments(0, 5, 12, 7)).toEqual([{ out: false, skip: 0, take: 5 }])
		expect(pageSegments(5, 5, 12, 7)).toEqual([
			{ out: false, skip: 5, take: 2 },
			{ out: true, skip: 0, take: 3 }
		])
		expect(pageSegments(10, 5, 12, 7)).toEqual([{ out: true, skip: 3, take: 2 }])
		expect(pageSegments(15, 5, 12, 7)).toEqual([])
		expect(pageSegments(0, 5, 3, 0)).toEqual([{ out: true, skip: 0, take: 3 }])
		expect(pageSegments(0, 5, 3, 3)).toEqual([{ out: false, skip: 0, take: 3 }])
	})
})

describe('slicePriced', () => {
	const rows = [priced(5, 100), priced(2, 100), priced(9, 50), priced(1, null), priced(3, 300)]
	it('orders by effective price, then id ascending, a missing price lowest', () => {
		expect(slicePriced(rows, 1, 0, 5).map(row => row._id)).toEqual([1, 9, 2, 5, 3].map(id))
		expect(slicePriced(rows, -1, 0, 5).map(row => row._id)).toEqual([3, 2, 5, 9, 1].map(id))
		expect(slicePriced(rows, 1, 1, 2).map(row => row._id)).toEqual([9, 2].map(id))
	})
})

describe('withTies', () => {
	it('reads every SKU of the edge price when the walk filled its limit', async () => {
		const ties = jest.fn(() =>
			Promise.resolve([priced(4, 100), priced(2, 100), priced(8, 100)])
		)
		const head = [priced(1, 50), priced(4, 100)]
		expect(await withTies(head, 2, ties)).toEqual([
			priced(1, 50),
			priced(4, 100),
			priced(2, 100),
			priced(8, 100)
		])
		expect(ties).toHaveBeenCalledTimes(1)
	})
	it('keeps a short walk as it is', async () => {
		const ties = jest.fn()
		expect(await withTies([priced(1, 50)], 2, ties)).toEqual([priced(1, 50)])
		expect(ties).not.toHaveBeenCalled()
	})
})
