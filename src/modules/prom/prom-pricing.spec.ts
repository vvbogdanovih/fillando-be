import {
	DiscountSnapshot,
	getMarkupAmount,
	resolveShopPrice,
	resolveVendorPrice,
	SNAPSHOT_TTL_DAYS
} from './prom-pricing'
import { PromProduct } from './prom.service'

const NOW = new Date('2026-08-19T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

const noSnapshot: DiscountSnapshot = { ratio: null, seenAt: null }

/** The vendor's live pattern: a fake pre-discount price of 1.3× the real one. */
const product = (over: Partial<PromProduct> = {}): PromProduct => ({
	id: 1,
	sku: 'SKU-1',
	price: 3250,
	currency: 'UAH',
	discount: { type: 'amount', value: 750, date_start: '19.08.2026', date_end: '28.09.2026' },
	...over
})

describe('getMarkupAmount', () => {
	it.each([
		[200, 30],
		[201, 35],
		[1000, 50],
		[2500, 110],
		[2501, 120]
	])('charges %i ₴ a markup of %i ₴', (vendorPrice, expected) => {
		expect(getMarkupAmount(vendorPrice)).toBe(expected)
	})
})

describe('resolveVendorPrice', () => {
	it('subtracts an active discount from the pre-discount price', () => {
		const result = resolveVendorPrice(product(), noSnapshot, false, NOW)

		expect(result).toEqual({ vendorPrice: 2500, ratio: 750 / 3250, source: 'payload' })
		expect(resolveShopPrice(result!.vendorPrice)).toBe(2610)
	})

	it('handles a percent discount', () => {
		const p = product({ discount: { type: 'percent', value: 20 } })

		expect(resolveVendorPrice(p, noSnapshot, false, NOW)).toEqual({
			vendorPrice: 2600,
			ratio: 0.2,
			source: 'payload'
		})
	})

	it('replays the remembered discount when Prom withholds it out of stock', () => {
		const p = product({ discount: null })
		const snapshot: DiscountSnapshot = { ratio: 750 / 3250, seenAt: new Date(NOW) }

		const result = resolveVendorPrice(p, snapshot, true, NOW)

		expect(result).toEqual({ vendorPrice: 2500, ratio: 750 / 3250, source: 'snapshot' })
		// The whole point: 2610 ₴, not the 3370 ₴ the bare pre-discount price would produce.
		expect(resolveShopPrice(result!.vendorPrice)).toBe(2610)
		expect(resolveShopPrice(3250)).toBe(3370)
	})

	it.each([
		[1235, 950],
		[2275, 1750],
		[1105, 850],
		[585, 450]
	])(
		'divides a base of %i ₴ by 1.3 to reach %i ₴ — the vendor builds its listed price by adding 30%%',
		(base, expected) => {
			const p = product({ price: base, discount: null })
			const snapshot: DiscountSnapshot = { ratio: 3 / 13, seenAt: new Date(NOW) }

			// A literal −23% would land 1–2 ₴ off on most of the catalogue.
			expect(resolveVendorPrice(p, snapshot, true, NOW)?.vendorPrice).toBeCloseTo(expected, 6)
		}
	)

	it('leaves the price alone out of stock with no discount to fall back on', () => {
		expect(resolveVendorPrice(product({ discount: null }), noSnapshot, true, NOW)).toBeNull()
	})

	it('ignores a remembered discount older than the TTL', () => {
		const snapshot: DiscountSnapshot = {
			ratio: 0.2308,
			seenAt: new Date(NOW.getTime() - (SNAPSHOT_TTL_DAYS + 1) * DAY_MS)
		}

		expect(resolveVendorPrice(product({ discount: null }), snapshot, true, NOW)).toBeNull()
	})

	it('takes the bare price when the discount window has closed', () => {
		const p = product({
			discount: {
				type: 'amount',
				value: 750,
				date_start: '01.06.2026',
				date_end: '18.08.2026'
			}
		})
		const snapshot: DiscountSnapshot = { ratio: 750 / 3250, seenAt: new Date(NOW) }

		// A promo that ended is a real price rise — the snapshot must not paper over it.
		expect(resolveVendorPrice(p, snapshot, false, NOW)).toEqual({
			vendorPrice: 3250,
			ratio: null,
			source: 'none'
		})
	})

	it('honours a window that opened today in Kyiv while the server clock still says yesterday', () => {
		// The vendor re-creates its campaign daily with date_start = today in Kyiv. At 22:00 UTC
		// that is already tomorrow in Kyiv, and a UTC server used to reject the discount and
		// reprice the whole catalogue off the bare base.
		const p = product({
			discount: {
				type: 'amount',
				value: 135,
				date_start: '20.08.2026',
				date_end: '29.09.2026'
			},
			price: 585
		})
		const duringTheOldGap = new Date('2026-08-19T22:00:00Z')

		const result = resolveVendorPrice(p, noSnapshot, false, duringTheOldGap)

		expect(result?.source).toBe('payload')
		expect(resolveShopPrice(result!.vendorPrice)).toBe(490)
	})

	it('still closes a window that ended yesterday in Kyiv', () => {
		const p = product({
			discount: {
				type: 'amount',
				value: 135,
				date_start: '01.06.2026',
				date_end: '18.08.2026'
			}
		})

		expect(
			resolveVendorPrice(p, noSnapshot, false, new Date('2026-08-19T22:00:00Z'))?.source
		).toBe('none')
	})

	it('takes the bare price before the discount window opens', () => {
		const p = product({
			discount: {
				type: 'amount',
				value: 750,
				date_start: '20.08.2026',
				date_end: '28.09.2026'
			}
		})

		expect(resolveVendorPrice(p, noSnapshot, false, NOW)?.source).toBe('none')
	})

	it('treats unparseable window bounds as open ended', () => {
		const p = product({ discount: { type: 'amount', value: 750, date_end: '2026-09-28' } })

		expect(resolveVendorPrice(p, noSnapshot, false, NOW)?.source).toBe('payload')
	})

	it('takes the bare price in stock with no discount at all', () => {
		expect(resolveVendorPrice(product({ discount: null }), noSnapshot, false, NOW)).toEqual({
			vendorPrice: 3250,
			ratio: null,
			source: 'none'
		})
	})

	it.each([
		['a non-UAH listing', { currency: 'USD' }],
		['a missing price', { price: null }],
		['a non-positive price', { price: 0 }]
	])('refuses to price from %s', (_label, over) => {
		expect(resolveVendorPrice(product(over), noSnapshot, false, NOW)).toBeNull()
	})

	it.each([
		['a zero value', 0],
		['a discount larger than the price', 3250]
	])('ignores a discount with %s', (_label, value) => {
		const p = product({ discount: { type: 'amount', value } })

		expect(resolveVendorPrice(p, noSnapshot, false, NOW)?.source).toBe('none')
	})
})

describe('resolveShopPrice', () => {
	it('rounds to whole ₴', () => {
		expect(resolveShopPrice(149.5 - 34.5)).toBe(145)
	})
})
