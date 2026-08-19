import { Logger } from '@nestjs/common'
import { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'
import { PromSyncService } from './prom-sync.service'
import { PromProduct, PromService } from './prom.service'

type Patch = Partial<ProductVariant>

const RATIO = 750 / 3250

const variant = (over: Partial<ProductVariant> = {}): ProductVariant =>
	({
		sku: 'SKU-1',
		price: 2610,
		stock: 4,
		prom_id: '3042',
		prom_base_price: 3250,
		prom_discount_ratio: RATIO,
		prom_discount_seen_at: new Date(),
		price_updated_at: new Date(),
		stock_updated_at: new Date(),
		...over
	}) as ProductVariant

const product = (over: Partial<PromProduct> = {}): PromProduct => ({
	id: 3042,
	sku: 'SKU-1',
	presence: 'available',
	in_stock: true,
	quantity_in_stock: 4,
	price: 3250,
	currency: 'UAH',
	discount: { type: 'amount', value: 750, date_start: '01.08.2026', date_end: '28.09.2026' },
	...over
})

/** Runs one variant through a sync and returns the patch handed to the repository. */
async function syncOne(p: PromProduct | null, v: ProductVariant) {
	const promService = { getProduct: jest.fn().mockResolvedValue(p) } as unknown as PromService
	const update = jest.fn<Promise<void>, [unknown, Patch]>(() => Promise.resolve())
	const variantRepo = { findAllWithPromId: jest.fn().mockResolvedValue([v]), update } as never

	const service = new PromSyncService(promService, variantRepo)
	const summary = await service.syncAvailability()

	return { patch: update.mock.calls[0]?.[1], summary }
}

describe('PromSyncService.syncAvailability', () => {
	beforeAll(() => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation()
		jest.spyOn(Logger.prototype, 'warn').mockImplementation()
	})

	afterAll(() => jest.restoreAllMocks())

	it('writes stock and the discounted price for an in-stock product', async () => {
		const { patch, summary } = await syncOne(product(), variant({ price: 1 }))

		expect(patch).toMatchObject({
			stock: 4,
			price: 2610,
			prom_base_price: 3250,
			prom_discount_ratio: RATIO
		})
		expect(summary).toMatchObject({ updated: 1, pricesUpdated: 1, priceSkipped: 0 })
	})

	it('omits `price` when the computed value already matches', async () => {
		const { patch, summary } = await syncOne(product(), variant())

		expect(patch).not.toHaveProperty('price')
		expect(patch?.price_updated_at).toBeInstanceOf(Date)
		expect(summary.pricesUpdated).toBe(0)
	})

	it('keeps repricing an out-of-stock variant off the remembered discount', async () => {
		const p = product({ presence: 'not_available', in_stock: false, discount: null })
		// The frozen-inflated case: 3370 ₴ was stored while the discount was missing.
		const { patch, summary } = await syncOne(p, variant({ price: 3370, stock: 0 }))

		expect(patch).toMatchObject({ stock: 0, price: 2610 })
		expect(summary.pricesUpdated).toBe(1)
	})

	it('does not renew the snapshot while replaying it out of stock', async () => {
		const p = product({ presence: 'not_available', in_stock: false, discount: null })
		const seenAt = new Date('2026-07-01T00:00:00Z')
		const { patch } = await syncOne(p, variant({ stock: 0, prom_discount_seen_at: seenAt }))

		// Re-stamping it here would push the TTL out on every sync and never expire.
		expect(patch).not.toHaveProperty('prom_discount_seen_at')
		expect(patch).not.toHaveProperty('prom_discount_ratio')
	})

	it('leaves an out-of-stock price alone when no discount was ever recorded', async () => {
		const p = product({ presence: 'not_available', in_stock: false, discount: null })
		const v = variant({
			price: 3370,
			stock: 0,
			prom_discount_ratio: null,
			prom_discount_seen_at: null
		})

		const { patch } = await syncOne(p, v)

		expect(patch).toEqual({ stock: 0, stock_updated_at: expect.any(Date) as Date })
	})

	it('rejects a steep rise when the payload carries no discount', async () => {
		const p = product({ discount: null })
		const { patch, summary } = await syncOne(p, variant())

		// 3250 + 120 = 3370 ₴ is +29% on the stored 2610 ₴ — a lapsed promo, not a price change.
		expect(patch).toEqual({ stock: 4, stock_updated_at: expect.any(Date) as Date })
		expect(summary).toMatchObject({ pricesUpdated: 0, priceSkipped: 1 })
	})

	it('accepts a steep rise when Prom does send an active discount', async () => {
		const p = product({ price: 6500, discount: { type: 'amount', value: 1500 } })
		const { patch, summary } = await syncOne(p, variant())

		expect(patch?.price).toBe(5120)
		expect(summary.priceSkipped).toBe(0)
	})

	it('accepts a modest undiscounted rise', async () => {
		const p = product({ price: 2700, discount: null })
		const { patch } = await syncOne(p, variant())

		expect(patch?.price).toBe(2820)
	})

	it('treats `presence` as authoritative over `in_stock`', async () => {
		const { patch } = await syncOne(product({ in_stock: false }), variant())

		expect(patch?.stock).toBe(4)
	})

	it('stores stock 1 for an available product with no tracked quantity', async () => {
		const { patch } = await syncOne(product({ quantity_in_stock: 0 }), variant())

		expect(patch?.stock).toBe(1)
	})

	it('counts a missing Prom product as skipped without writing', async () => {
		const { patch, summary } = await syncOne(null, variant())

		expect(patch).toBeUndefined()
		expect(summary).toMatchObject({ skipped: 1, updated: 0 })
	})

	it('refuses to run two syncs at once', async () => {
		const promService = {
			getProduct: jest.fn().mockResolvedValue(product())
		} as unknown as PromService
		const variantRepo = {
			findAllWithPromId: jest.fn().mockResolvedValue([variant()]),
			update: jest.fn().mockResolvedValue(undefined)
		} as never

		const service = new PromSyncService(promService, variantRepo)
		const first = service.syncAvailability()

		await expect(service.syncAvailability()).rejects.toThrow(/вже виконується/)
		await first
	})
})
