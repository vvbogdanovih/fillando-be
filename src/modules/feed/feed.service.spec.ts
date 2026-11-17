import { ConflictException } from '@nestjs/common'
import { FEED_EXCLUSION_SAMPLE, FeedService, feedXmlOf, type FeedArtifact } from './feed.service'
import type { FeedRawRow } from './feed.types'
import { buildFeedXml, buildItem } from './google-shopping-feed.builder'

const row = (overrides: Partial<FeedRawRow> = {}): FeedRawRow => ({
	id: 'v1',
	product_id: 'p1',
	sku: 'FL-000001',
	name: 'Kingroon PLA — Чорний (Black)',
	slug: 'kingroon-pla-black',
	price: 419,
	promo_percent: null,
	promo_ends_at: null,
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

/** A variant Merchant would reject outright — the cheapest way to make a run yield zero items. */
const brandlessRow = (sku: string): FeedRawRow =>
	row({
		sku,
		product: { ...row().product!, attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }] }
	})

/** The repository's cursor over rows that may still be arriving. */
async function* cursor(rows: FeedRawRow[] | Promise<FeedRawRow[]>): AsyncGenerator<FeedRawRow> {
	yield* await rows
}
/** A cursor whose first batch fails. */
// eslint-disable-next-line require-yield, @typescript-eslint/require-await
async function* failing(error: Error): AsyncGenerator<FeedRawRow> {
	throw error
}
const xmlOf = (artifact: FeedArtifact | null) => (artifact ? feedXmlOf(artifact) : null)

const groupedOf = (rows: FeedRawRow[]) => {
	const counts = new Map<string, number>()
	for (const item of rows) counts.set(item.product_id, (counts.get(item.product_id) ?? 0) + 1)
	return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id))
}
const build = (rows: FeedRawRow[], landings: unknown[] = [], sold = new Map<string, number>()) => {
	const productVariantRepository = {
		findActiveForFeed: jest.fn((): AsyncIterable<FeedRawRow> => cursor(rows)),
		// Products with more than one active variant, as the repository counts them.
		findGroupedProductIds: jest.fn(() => Promise.resolve(groupedOf(rows)))
	}
	const landingRepository = { findActive: jest.fn().mockResolvedValue(landings) }
	const orderRepository = { countSoldByVariantSince: jest.fn().mockResolvedValue(sold) }
	const service = new FeedService(
		productVariantRepository as never,
		landingRepository as never,
		orderRepository as never,
		{
			beginRead: jest.fn().mockResolvedValue({ initialized: false, revision: 0, epoch: 0 }),
			finishRead: jest.fn().mockResolvedValue(undefined)
		} as never
	)
	return { service, productVariantRepository, landingRepository, orderRepository }
}

describe('FeedService', () => {
	it('serves nothing before the first generation, then the built XML', async () => {
		const { service } = build([row()])
		expect(service.getXml()).toBeNull()
		expect(service.getStatus()).toMatchObject({ xml_ready: false, summary: null })

		const summary = await service.generate()

		expect(summary).toMatchObject({
			item_count: 1,
			in_stock: 1,
			out_of_stock: 0,
			excluded: [],
			excluded_count: 0,
			excluded_by_reason: {}
		})
		const cached = xmlOf(service.getXml())
		expect(cached).toContain('<g:id>FL-000001</g:id>')
		expect(cached).toContain('<link>http://localhost:9000/products/kingroon-pla-black</link>')
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
		expect(summary.excluded_count).toBe(1)
		expect(summary.excluded_by_reason).toEqual({ missing_brand: 1 })
		expect(summary.warnings).toEqual(
			expect.arrayContaining([
				{ code: 'no_weight', count: 1, unit: 'item', item_count: 1, skus: ['FL-NOWEIGHT'] },
				{
					code: 'no_google_product_category',
					count: 1,
					unit: 'category',
					item_count: 1,
					skus: ['FL-NOGPC']
				}
			])
		)
		expect(summary.warning_kinds).toBe(2)
		expect(summary.warned_items).toBe(2)
		expect(summary).toMatchObject({ ok: true, failure_reason: null, error: null })
	})

	it('counts the taxonomy gap in categories, not in feed rows', async () => {
		const untagged = { ...row().category!, google_product_category: null }
		const rows = [
			row({ sku: 'FL-A', category: untagged }),
			row({ sku: 'FL-B', category: untagged }),
			row({ sku: 'FL-C', category: { ...untagged, id: 'c2', name: 'Аксесуари' } })
		]

		const summary = await build(rows).service.generate()

		expect(summary.warnings).toEqual([
			{
				code: 'no_google_product_category',
				count: 2,
				unit: 'category',
				item_count: 3,
				skus: ['FL-A', 'FL-B', 'FL-C']
			}
		])
		expect(summary.warning_kinds).toBe(1)
		expect(summary.warned_items).toBe(3)
	})

	it('warns about a required attribute left empty and names it by its label', async () => {
		const required = [{ key: 'diameter', label: 'Діаметр', is_required: true }]
		const blank = row({
			sku: 'FL-BLANK',
			product: {
				...row().product!,
				attributes: [...row().product!.attributes, { k: 'diameter', l: 'Діаметр', v: '' }]
			},
			category: { ...row().category!, required_attributes: required }
		})
		const absent = row({
			sku: 'FL-ABSENT',
			category: { ...row().category!, required_attributes: required }
		})

		const summary = await build([blank, absent]).service.generate()

		expect(summary.item_count).toBe(2)
		expect(summary.warnings).toEqual([
			{
				code: 'missing_required_attribute',
				count: 2,
				unit: 'item',
				item_count: 2,
				skus: ['FL-BLANK', 'FL-ABSENT'],
				detail: { diameter: 2 },
				attributes: [{ key: 'diameter', label: 'Діаметр', count: 2 }]
			}
		])
	})

	it('refines product_type from the matching landing and counts it', async () => {
		const landings = [
			{ category_id: 'c1', h1: 'PLA філамент', order: 10, filters: { polymer: ['PLA'] } }
		]
		const { service } = build([row()], landings)
		const summary = await service.generate()

		expect(summary.typed_by_landing).toBe(1)
		expect(xmlOf(service.getXml())).toContain(
			'<g:product_type>Філамент &gt; PLA філамент</g:product_type>'
		)
	})

	it('labels sales velocity from the paid orders of the trailing window', async () => {
		const { service, orderRepository } = build([row()], [], new Map([['v1', 12]]))
		await service.generate()

		expect(xmlOf(service.getXml())).toContain('<g:custom_label_4>bestseller</g:custom_label_4>')
		const [[since]] = orderRepository.countSoldByVariantSince.mock.calls as [Date][]
		expect(Date.now() - since.getTime()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000)
	})

	it('refuses to run two generations at once', async () => {
		let release: (rows: FeedRawRow[]) => void = () => undefined
		const { service, productVariantRepository } = build([])
		const pendingRows = new Promise<FeedRawRow[]>(resolve => (release = resolve))
		productVariantRepository.findActiveForFeed.mockReturnValueOnce(cursor(pendingRows))

		const first = service.generate()
		expect(service.isRunning).toBe(true)
		await expect(service.generate()).rejects.toBeInstanceOf(ConflictException)

		release([row()])
		await expect(first).resolves.toMatchObject({ item_count: 1 })
		expect(service.isRunning).toBe(false)
	})

	it('runs a rebuild requested during a generation once that generation ends — whoever started it (TD-0012)', async () => {
		let release: (rows: FeedRawRow[]) => void = () => undefined
		const { service, productVariantRepository } = build([row()])
		const pendingRows = new Promise<FeedRawRow[]>(resolve => (release = resolve))
		productVariantRepository.findActiveForFeed.mockReturnValueOnce(cursor(pendingRows))

		// The admin's manual button: a run the cron never sees.
		const manual = service.generate()
		expect(service.isRunning).toBe(true)
		service.requestRerun()

		release([row()])
		await expect(manual).resolves.toMatchObject({ item_count: 1 })
		// The follower compresses off the main thread: wait for it rather than for one tick.
		while (service.isRunning) await new Promise<void>(resolve => setTimeout(resolve, 1))

		// The follower read the catalogue after the request, so the published XML is fresh.
		expect(productVariantRepository.findActiveForFeed).toHaveBeenCalledTimes(2)
		expect(service.isRunning).toBe(false)
	})

	it('ignores a rerun request while nothing is running — the caller generates itself', async () => {
		const { service, productVariantRepository } = build([row()])
		service.requestRerun()
		await service.generate()
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(productVariantRepository.findActiveForFeed).toHaveBeenCalledTimes(1)
	})

	it('sends g:item_group_id only for a product with more than one active variant', async () => {
		const { service, productVariantRepository } = build([
			row(),
			row({ id: 'v2', sku: 'FL-000002', slug: 'b' }),
			row({ id: 'v3', sku: 'FL-000003', slug: 'c', product_id: 'single' })
		])
		await service.generate()
		const items = xmlOf(service.getXml())!.split('</item>')
		expect(items.filter(item => item.includes('<g:item_group_id>'))).toHaveLength(2)
		expect(items.find(item => item.includes('FL-000003'))).not.toContain('g:item_group_id')
		expect(productVariantRepository.findGroupedProductIds).toHaveBeenCalledTimes(1)
	})

	it('streams the same document the item list builds, and serves its byte length', async () => {
		const rows = [
			row(),
			row({ id: 'v2', sku: 'FL-000002', slug: 'b', stock: 0, weight_g: null }),
			brandlessRow('FL-000003'),
			row({ id: 'v4', sku: 'FL-000004', slug: 'd', promo_percent: 10 })
		]
		const { service } = build(rows)
		const summary = await service.generate()
		const now = new Date(summary.generated_at)
		const items = rows.flatMap(item => {
			const built = buildItem(item, {
				frontendUrl: 'http://localhost:9000',
				productType: 'Філамент',
				inGroup: true,
				unitsSold: 0,
				now
			})
			return built.ok ? [built.xml] : []
		})
		const expected = buildFeedXml(items, {
			title: 'Fillando',
			link: 'http://localhost:9000',
			description: 'Каталог товарів Fillando',
			generatedAt: now
		})
		const artifact = service.getXml()!
		expect(feedXmlOf(artifact)).toBe(expected)
		expect(artifact.bytes).toBe(Buffer.byteLength(expected))
		expect(artifact.generatedAt).toEqual(now)
	})

	it('lists a bounded sample of exclusions and counts them all by reason', async () => {
		const brandless = Array.from({ length: FEED_EXCLUSION_SAMPLE + 5 }, (_, n) =>
			brandlessRow(`FL-X${String(n).padStart(4, '0')}`)
		)
		const imageless = row({ sku: 'FL-Y', images: [] })
		const summary = await build([row(), ...brandless, imageless]).service.generate()

		expect(summary.item_count).toBe(1)
		expect(summary.excluded).toHaveLength(FEED_EXCLUSION_SAMPLE)
		expect(summary.excluded[0].sku).toBe('FL-X0000')
		expect(summary.excluded_count).toBe(FEED_EXCLUSION_SAMPLE + 6)
		expect(summary.excluded_by_reason).toEqual({
			missing_brand: FEED_EXCLUSION_SAMPLE + 5,
			no_images: 1
		})
	})

	it('refuses to publish a zero-item feed and keeps the previous XML', async () => {
		const { service, productVariantRepository } = build([row()])
		await service.generate()
		const before = service.getXml()
		const publishedSummary = service.getStatus().summary

		// Every variant excluded — the shape of a data collapse, e.g. «Виробник» wiped catalogue-wide.
		productVariantRepository.findActiveForFeed.mockReturnValueOnce(
			cursor([brandlessRow('FL-NOBRAND')])
		)
		const summary = await service.generate()

		expect(summary).toMatchObject({ ok: false, failure_reason: 'empty_feed', item_count: 0 })
		expect(summary.error).toContain('Фід не оновлено')
		expect(summary.error).toContain('виключено: 1')
		expect(service.getXml()).toEqual(before)
		const status = service.getStatus()
		expect(status.last_error).toBe(summary.error)
		// The generated_at of the published feed must not move for a run that published nothing.
		expect(status.summary).toBe(publishedSummary)
		expect(status.xml_ready).toBe(true)
	})

	it('stays "not generated" when the very first run yields zero items', async () => {
		const { service } = build([brandlessRow('FL-NOBRAND')])

		const summary = await service.generate()

		expect(summary).toMatchObject({ ok: false, failure_reason: 'empty_feed', item_count: 0 })
		expect(summary.error).toContain('Фід не згенеровано')
		expect(summary.error).toContain('503')
		// Nothing cached, so the controller keeps answering 503 instead of an empty channel.
		expect(service.getXml()).toBeNull()
		expect(service.getStatus()).toMatchObject({ xml_ready: false, summary: null })
		expect(service.getStatus().last_error).toBe(summary.error)
		expect(service.isRunning).toBe(false)
	})

	it('keeps the previous XML and records the error when a regeneration fails', async () => {
		const { service, productVariantRepository } = build([row()])
		await service.generate()
		const before = service.getXml()

		productVariantRepository.findActiveForFeed.mockReturnValueOnce(failing(new Error('boom')))
		await expect(service.generate()).rejects.toThrow('boom')

		expect(service.getXml()).toEqual(before)
		expect(service.getStatus().last_error).toBe('boom')
		expect(service.isRunning).toBe(false)
	})
})

it('retains the last good XML and summary when a category was not fully migrated', async () => {
	const { service, productVariantRepository } = build([row()])
	await service.generate()
	const cached = service.getXml()
	const broken = row()
	broken.category!.required_attributes = [{ key: 'finish', label: 'Ефект' } as never]
	productVariantRepository.findActiveForFeed.mockImplementation(() => cursor([broken]))
	await expect(service.generate()).rejects.toThrow('is_required')
	expect(service.getXml()).toEqual(cached)
	expect(service.getStatus().last_error).toContain('is_required')
	expect(service.getStatus()).toMatchObject({
		generating: false,
		xml_ready: true
	})
})
