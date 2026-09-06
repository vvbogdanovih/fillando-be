import type { FeedRawRow } from './feed.types'
import {
	availabilityOf,
	buildFeedXml,
	buildItem,
	cdata,
	descriptionText,
	priceBandLabel,
	salesVelocityLabel,
	stockDepthLabel,
	xmlEscape
} from './google-shopping-feed.builder'

const CTX = { frontendUrl: 'https://fillando.com', productType: 'Філамент > PLA Silk філамент' }

const row = (): FeedRawRow => ({
	id: '000000000000000000000002',
	product_id: '000000000000000000000001',
	sku: 'FL-000342',
	name: 'Sunlu PLA Silk 1,75 мм 1 кг — Золотий (Gold)',
	slug: 'sunlu-pla-silk-gold',
	price: 549,
	stock: 7,
	images: ['https://cdn.example.invalid/gold-1.jpg', 'https://cdn.example.invalid/gold-2.jpg'],
	v_value: 'Gold',
	weight_g: 1220,
	product: {
		name: 'Sunlu PLA Silk 1,75 мм 1 кг',
		description_html: '<p>Шовковий <b>PLA</b> &amp; блиск</p>',
		attributes: [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
			{ k: 'spool_included', l: 'Котушка в комплекті', v: 'Так' }
		],
		variant_type: { key: 'kolir', label: 'Колір' }
	},
	category: {
		id: '000000000000000000000003',
		name: 'Філамент',
		google_product_category: {
			id: 499682,
			path: 'Electronics > Print, Copy, Scan & Fax > 3D Printer Accessories'
		},
		required_attributes: [
			{ key: 'polymer', label: 'Тип пластику' },
			{ key: 'spool_included', label: 'Котушка в комплекті' }
		]
	},
	color: { name_uk: 'Золотий', name_en: 'Gold' }
})

const xmlOf = (built: ReturnType<typeof buildItem>) => (built.ok ? built.xml : '')

describe('xml helpers', () => {
	it('escapes the five metacharacters', () => {
		expect(xmlEscape(`a < b & c > "d" 'e'`)).toBe(
			'a &lt; b &amp; c &gt; &quot;d&quot; &apos;e&apos;'
		)
	})

	it('wraps text in CDATA and splits a literal terminator', () => {
		expect(cdata('x')).toBe('<![CDATA[x]]>')
		expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>')
	})

	it('uses the underscored availability values', () => {
		expect(availabilityOf(3)).toBe('in_stock')
		expect(availabilityOf(0)).toBe('out_of_stock')
		expect(availabilityOf(-1)).toBe('out_of_stock')
	})

	it('buckets stock depth and price band', () => {
		expect([stockDepthLabel(11), stockDepthLabel(10), stockDepthLabel(0)]).toEqual([
			'deep',
			'low',
			'out'
		])
		expect([priceBandLabel(499), priceBandLabel(1500), priceBandLabel(1501)]).toEqual([
			'budget',
			'mid',
			'premium'
		])
		expect([salesVelocityLabel(10), salesVelocityLabel(3), salesVelocityLabel(2)]).toEqual([
			'bestseller',
			'popular',
			'standard'
		])
	})

	it('turns description HTML into collapsed plain text and caps it at 5000', () => {
		expect(descriptionText('<p>Шовковий <b>PLA</b>\n\n  &amp; блиск</p>')).toBe(
			'Шовковий PLA & блиск'
		)
		expect(
			descriptionText('<h2>Особливості</h2><ul><li>Міцний</li><li>Без запаху</li></ul>')
		).toBe('Особливості Міцний Без запаху')
		expect(descriptionText(null)).toBe('')
		expect(descriptionText('x'.repeat(6000)).length).toBe(5000)
	})
})

describe('buildItem', () => {
	it('emits every mapped field for a complete row', () => {
		const built = buildItem(row(), CTX)
		expect(built.ok).toBe(true)
		const xml = xmlOf(built)

		expect(xml).toContain('<g:id>FL-000342</g:id>')
		expect(xml).toContain('<g:item_group_id>000000000000000000000001</g:item_group_id>')
		expect(xml).toContain('<title>Sunlu PLA Silk 1,75 мм 1 кг — Золотий (Gold)</title>')
		expect(xml).toContain('<description><![CDATA[Шовковий PLA & блиск]]></description>')
		expect(xml).toContain('<link>https://fillando.com/products/sunlu-pla-silk-gold</link>')
		expect(xml).toContain('<g:image_link>https://cdn.example.invalid/gold-1.jpg</g:image_link>')
		expect(xml).toContain(
			'<g:additional_image_link>https://cdn.example.invalid/gold-2.jpg</g:additional_image_link>'
		)
		expect(xml).toContain('<g:availability>in_stock</g:availability>')
		expect(xml).toContain('<g:price>549.00 UAH</g:price>')
		expect(xml).toContain('<g:brand>Sunlu</g:brand>')
		expect(xml).toContain('<g:condition>new</g:condition>')
		expect(xml).toContain('<g:identifier_exists>false</g:identifier_exists>')
		expect(xml).toContain('<g:google_product_category>499682</g:google_product_category>')
		expect(xml).toContain('<g:product_type>Філамент &gt; PLA Silk філамент</g:product_type>')
		expect(xml).toContain('<g:color>Золотий</g:color>')
		expect(xml).toContain('<g:material>PLA</g:material>')
		expect(xml).toContain('<g:shipping_weight>1.22 kg</g:shipping_weight>')
		expect(xml).toContain('<g:custom_label_0>Філамент</g:custom_label_0>')
		expect(xml).toContain('<g:custom_label_1>Sunlu</g:custom_label_1>')
		expect(xml).toContain('<g:custom_label_2>low</g:custom_label_2>')
		expect(xml).toContain('<g:custom_label_3>mid</g:custom_label_3>')
		expect(xml).toContain('<g:custom_label_4>standard</g:custom_label_4>')
		expect(built.ok && built.warnings).toEqual([])
	})

	it('marks a variant with enough recent sales as a bestseller', () => {
		const xml = xmlOf(buildItem(row(), { ...CTX, unitsSold: 25 }))
		expect(xml).toContain('<g:custom_label_4>bestseller</g:custom_label_4>')
	})

	it('never carries a margin or supplier value — the labels are stock depth and price band', () => {
		const xml = xmlOf(buildItem(row(), CTX))
		expect(xml).not.toMatch(/prom|margin|vendor_product_sku/i)
	})

	it('excludes a variant without a manufacturer attribute — no shop-name fallback', () => {
		const r = row()
		r.product!.attributes = r.product!.attributes.filter(a => a.k !== 'vyrobnyk')
		expect(buildItem(r, CTX)).toEqual({ ok: false, reason: 'missing_brand' })
	})

	it.each([
		['no_images', (r: FeedRawRow) => (r.images = [])],
		['no_price', (r: FeedRawRow) => (r.price = 0)],
		['dangling_product', (r: FeedRawRow) => (r.product = null)],
		['dangling_category', (r: FeedRawRow) => (r.category = null)]
	])('excludes with reason %s', (reason, mutate) => {
		const r = row()
		mutate(r)
		expect(buildItem(r, CTX)).toEqual({ ok: false, reason })
	})

	it('degrades to warnings and omitted fields instead of inventing values', () => {
		const r = row()
		r.product!.description_html = null
		r.category!.google_product_category = null
		r.weight_g = null
		r.product!.attributes = r.product!.attributes.filter(a => a.k !== 'spool_included')

		const built = buildItem(r, CTX)
		expect(built.ok).toBe(true)
		const xml = xmlOf(built)
		expect(xml).not.toContain('<g:google_product_category>')
		expect(xml).not.toContain('<g:shipping_weight>')
		// The title stands in for a missing description — a required field may not be empty.
		expect(xml).toContain(
			'<description><![CDATA[Sunlu PLA Silk 1,75 мм 1 кг — Золотий (Gold)]]></description>'
		)
		expect(built.ok && built.warnings.sort()).toEqual(
			[
				'missing_required_attribute',
				'no_description',
				'no_google_product_category',
				'no_weight'
			].sort()
		)
		expect(built.ok && built.missing_required).toEqual(['spool_included'])
	})

	it('falls back to the legacy colour and material heuristics when the dictionary has a gap', () => {
		const r = row()
		r.color = null
		r.v_value = 'Чорний'
		r.product!.attributes = [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
			{ k: 'material', l: 'Матеріал', v: 'PLA Silk' }
		]
		const xml = xmlOf(buildItem(r, CTX))
		expect(xml).toContain('<g:color>Чорний</g:color>')
		expect(xml).toContain('<g:material>PLA Silk</g:material>')
	})

	it('reports out_of_stock and the "out" label at zero stock instead of dropping the item', () => {
		const r = row()
		r.stock = 0
		const xml = xmlOf(buildItem(r, CTX))
		expect(xml).toContain('<g:availability>out_of_stock</g:availability>')
		expect(xml).toContain('<g:custom_label_2>out</g:custom_label_2>')
	})

	it('caps additional images at ten', () => {
		const r = row()
		r.images = Array.from({ length: 15 }, (_, i) => `https://cdn.example.invalid/${i}.jpg`)
		const xml = xmlOf(buildItem(r, CTX))
		expect(xml.match(/<g:additional_image_link>/g)).toHaveLength(10)
	})

	it('escapes metacharacters in titles and links', () => {
		const r = row()
		r.name = 'PLA "Rainbow" & <Glow>'
		const xml = xmlOf(buildItem(r, CTX))
		expect(xml).toContain('<title>PLA &quot;Rainbow&quot; &amp; &lt;Glow&gt;</title>')
	})
})

describe('buildFeedXml', () => {
	it('wraps items in an RSS 2.0 channel with the Google namespace', () => {
		const xml = buildFeedXml(['<item>\n  <g:id>x</g:id>\n</item>'], {
			title: 'Fillando',
			link: 'https://fillando.com',
			description: 'Філамент',
			generatedAt: new Date('2026-09-06T10:00:00Z')
		})
		expect(
			xml.startsWith(
				'<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">'
			)
		).toBe(true)
		expect(xml).toContain('<lastBuildDate>Sun, 06 Sep 2026 10:00:00 GMT</lastBuildDate>')
		expect(xml).toContain('<g:id>x</g:id>')
		expect(xml.trimEnd().endsWith('</rss>')).toBe(true)
	})
})
