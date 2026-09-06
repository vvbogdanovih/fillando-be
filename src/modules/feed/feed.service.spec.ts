import { ConflictException } from '@nestjs/common'
import { FeedService } from './feed.service'
import type { FeedRawRow } from './feed.types'

const row = (overrides: Partial<FeedRawRow> = {}): FeedRawRow => ({
	id: 'v1',
	product_id: 'p1',
	sku: 'FL-000001',
	name: 'Kingroon PLA — Чорний (Black)',
	slug: 'kingroon-pla-black',
	price: 419,
	stock: 12,
	images: ['https://cdn.example.invalid/1.jpg'],
	v_value: 'Black',
	weight_g: 1220,
	product: {
		name: 'Kingroon PLA',
		description_html: '<p>PLA</p>',
		attributes: [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }
		],
		variant_type: null
	},
	category: {
		id: 'c1',
		name: 'Філамент',
		google_product_category: { id: 499682, path: 'Electronics > …' },
		required_attributes: []
	},
	color: { name_uk: 'Чорний', name_en: 'Black' },
	...overrides
})

const build = (rows: FeedRawRow[], landings: unknown[] = [], sold = new Map<string, number>()) => {
	const productVariantRepository = { findActiveForFeed: jest.fn().mockResolvedValue(rows) }
	const landingRepository = { findActive: jest.fn().mockResolvedValue(landings) }
	const orderRepository = { countSoldByVariantSince: jest.fn().mockResolvedValue(sold) }
	const service = new FeedService(
		productVariantRepository as never,
		landingRepository as never,
		orderRepository as never
	)
	return { service, productVariantRepository, landingRepository, orderRepository }
}

describe('FeedService', () => {
	it('serves nothing before the first generation, then the built XML', async () => {
		const { service } = build([row()])
		expect(service.getXml()).toBeNull()
		expect(service.getStatus()).toMatchObject({ xml_ready: false, summary: null })

		const summary = await service.generate()

		expect(summary).toMatchObject({ item_count: 1, in_stock: 1, out_of_stock: 0, excluded: [] })
		const cached = service.getXml()
		expect(cached?.xml).toContain('<g:id>FL-000001</g:id>')
		expect(cached?.xml).toContain(
			'<link>http://localhost:9000/products/kingroon-pla-black</link>'
		)
		expect(service.getStatus()).toMatchObject({
			xml_ready: true,
			generating: false,
			feed_path: '/feeds/google-shopping.xml',
			last_error: null
		})
	})

	it('reports exclusions by reason and aggregates warnings by code', async () => {
		const noBrand = row({
			sku: 'FL-NOBRAND',
			product: {
				...row().product!,
				attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }]
			}
		})
		const noWeight = row({ sku: 'FL-NOWEIGHT', weight_g: null, stock: 0 })
		const noCategoryNode = row({
			sku: 'FL-NOGPC',
			category: { ...row().category!, google_product_category: null }
		})

		const summary = await build([row(), noBrand, noWeight, noCategoryNode]).service.generate()

		expect(summary.item_count).toBe(3)
		expect(summary.in_stock).toBe(2)
		expect(summary.out_of_stock).toBe(1)
		expect(summary.excluded).toEqual([
			{ sku: 'FL-NOBRAND', name: noBrand.name, reason: 'missing_brand' }
		])
		expect(summary.warnings).toEqual(
			expect.arrayContaining([
				{ code: 'no_weight', count: 1, skus: ['FL-NOWEIGHT'] },
				{ code: 'no_google_product_category', count: 1, skus: ['FL-NOGPC'] }
			])
		)
	})

	it('refines product_type from the matching landing and counts it', async () => {
		const landings = [
			{ category_id: 'c1', h1: 'PLA філамент', order: 10, filters: { polymer: ['PLA'] } }
		]
		const { service } = build([row()], landings)
		const summary = await service.generate()

		expect(summary.typed_by_landing).toBe(1)
		expect(service.getXml()?.xml).toContain(
			'<g:product_type>Філамент &gt; PLA філамент</g:product_type>'
		)
	})

	it('labels sales velocity from the paid orders of the trailing window', async () => {
		const { service, orderRepository } = build([row()], [], new Map([['v1', 12]]))
		await service.generate()

		expect(service.getXml()?.xml).toContain('<g:custom_label_4>bestseller</g:custom_label_4>')
		const [[since]] = orderRepository.countSoldByVariantSince.mock.calls as [Date][]
		expect(Date.now() - since.getTime()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000)
	})

	it('refuses to run two generations at once', async () => {
		let release: (rows: FeedRawRow[]) => void = () => undefined
		const { service, productVariantRepository } = build([])
		productVariantRepository.findActiveForFeed.mockImplementationOnce(
			() => new Promise<FeedRawRow[]>(resolve => (release = resolve))
		)

		const first = service.generate()
		expect(service.isRunning).toBe(true)
		await expect(service.generate()).rejects.toBeInstanceOf(ConflictException)

		release([row()])
		await expect(first).resolves.toMatchObject({ item_count: 1 })
		expect(service.isRunning).toBe(false)
	})

	it('keeps the previous XML and records the error when a regeneration fails', async () => {
		const { service, productVariantRepository } = build([row()])
		await service.generate()
		const before = service.getXml()

		productVariantRepository.findActiveForFeed.mockRejectedValueOnce(new Error('boom'))
		await expect(service.generate()).rejects.toThrow('boom')

		expect(service.getXml()).toEqual(before)
		expect(service.getStatus().last_error).toBe('boom')
		expect(service.isRunning).toBe(false)
	})
})
