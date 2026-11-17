import type { FeedRawRow } from './feed.types'
import {
	availabilityOf,
	buildFeedXml,
	buildItem,
	FEED_XML_TAIL,
	feedXmlHead,
	cdata,
	descriptionText,
	isAttrValueEmpty,
	priceBandLabel,
	productHighlights,
	salesVelocityLabel,
	stockDepthLabel,
	typeFamilyLabel,
	xmlEscape
} from './google-shopping-feed.builder'

const CTX = {
	frontendUrl: 'https://fillando.com',
	productType: 'Філамент > PLA Silk філамент',
	inGroup: true
}

const row = (): FeedRawRow => ({
	id: '000000000000000000000002',
	product_id: '000000000000000000000001',
	sku: 'FL-000342',
	name: 'Sunlu PLA Silk — Золотий (Gold)',
	slug: 'sunlu-pla-silk-gold',
	price: 549,
	promo_percent: null,
	promo_ends_at: null,
	stock: 7,
	images: ['https://cdn.example.invalid/gold-1.jpg', 'https://cdn.example.invalid/gold-2.jpg'],
	v_value: 'Gold',
	weight_g: 1220,
	product: {
		name: 'Sunlu PLA Silk',
		description_html: '<p>Шовковий <b>PLA</b> &amp; блиск</p>',
		attributes: [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
			{ k: 'diametr', l: 'Діаметр', v: '1.75' },
			{ k: 'vaha', l: 'Вага філаменту', v: '1' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
			{ k: 'finish', l: 'Ефект поверхні', v: 'Silk' },
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
			{ key: 'diametr', label: 'Діаметр', is_required: true, unit: 'мм' },
			{ key: 'vaha', label: 'Вага філаменту', is_required: true, unit: 'кг' },
			{ key: 'polymer', label: 'Тип пластику', is_required: true, unit: null },
			{ key: 'spool_included', label: 'Котушка в комплекті', is_required: true, unit: null }
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

	it('reads an attribute value as empty only when it truly carries none', () => {
		expect([
			isAttrValueEmpty(undefined),
			isAttrValueEmpty(null),
			isAttrValueEmpty('  ')
		]).toEqual([true, true, true])
		expect([isAttrValueEmpty(0), isAttrValueEmpty(false), isAttrValueEmpty('1,75 мм')]).toEqual(
			[false, false, false]
		)
		// An older save could have stored a list of values; empty is still empty.
		expect([isAttrValueEmpty([]), isAttrValueEmpty(['']), isAttrValueEmpty(['PLA'])]).toEqual([
			true,
			true,
			false
		])
	})
})

describe('buildItem', () => {
	it('groups a SKU only when its product has more than one active variant (TD-0013 D04)', () => {
		expect(xmlOf(buildItem(row(), CTX))).toContain(
			'<g:item_group_id>000000000000000000000001</g:item_group_id>'
		)
		// A product without variation: no group ID, every other field unchanged.
		const single = xmlOf(buildItem(row(), { ...CTX, inGroup: false }))
		expect(single).not.toContain('g:item_group_id')
		expect(single).toBe(
			xmlOf(buildItem(row(), CTX)).replace(
				'  <g:item_group_id>000000000000000000000001</g:item_group_id>\n',
				''
			)
		)
	})
	it('emits every mapped field for a complete row', () => {
		const built = buildItem(row(), CTX)
		expect(built.ok).toBe(true)
		const xml = xmlOf(built)

		expect(xml).toContain('<g:id>FL-000342</g:id>')
		expect(xml).toContain('<g:item_group_id>000000000000000000000001</g:item_group_id>')
		expect(xml).toContain('<title>Sunlu PLA Silk — Золотий (Gold)</title>')
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
		expect(xml).toContain('<g:product_highlight>Діаметр: 1.75 мм</g:product_highlight>')
		expect(xml).toContain('<g:product_highlight>Вага філаменту: 1 кг</g:product_highlight>')
		expect(xml).toContain('<g:product_highlight>Ефект поверхні: Silk</g:product_highlight>')
		expect(xml).toContain('<g:custom_label_0>decorative</g:custom_label_0>')
		expect(xml).toContain('<g:custom_label_1>Sunlu</g:custom_label_1>')
		expect(xml).toContain('<g:custom_label_2>low</g:custom_label_2>')
		expect(xml).toContain('<g:custom_label_3>mid</g:custom_label_3>')
		expect(xml).toContain('<g:custom_label_4>standard</g:custom_label_4>')
		expect(built.ok && built.warnings).toEqual([])
	})

	describe('promotions (TD-0012)', () => {
		const NOW = new Date('2026-10-04T12:00:00.000Z')
		const ENDS = new Date('2026-11-01T00:00:00.000Z')
		const onSale = (over: Partial<FeedRawRow> = {}): FeedRawRow => ({
			...row(),
			promo_percent: 15,
			promo_ends_at: ENDS,
			...over
		})

		it('sends the regular price as price and the sale price with its window', () => {
			const xml = xmlOf(buildItem(onSale(), { ...CTX, now: NOW }))
			expect(xml).toContain('<g:price>549.00 UAH</g:price>')
			expect(xml).toContain('<g:sale_price>467.00 UAH</g:sale_price>')
			expect(xml).toContain(
				'<g:sale_price_effective_date>2026-10-04T12:00:00+00:00/2026-11-01T00:00:00+00:00</g:sale_price_effective_date>'
			)
		})

		it('bands by what the shopper pays: 549 is mid, 467 on sale is budget', () => {
			expect(xmlOf(buildItem(row(), CTX))).toContain(
				'<g:custom_label_3>mid</g:custom_label_3>'
			)
			expect(xmlOf(buildItem(onSale(), { ...CTX, now: NOW }))).toContain(
				'<g:custom_label_3>budget</g:custom_label_3>'
			)
		})

		it('sends an open-ended promo without an effective date', () => {
			const xml = xmlOf(buildItem(onSale({ promo_ends_at: null }), { ...CTX, now: NOW }))
			expect(xml).toContain('<g:sale_price>467.00 UAH</g:sale_price>')
			expect(xml).not.toContain('g:sale_price_effective_date')
		})

		it('sends neither tag once the promo has ended, and bands by the regular price again', () => {
			const xml = xmlOf(
				buildItem(onSale(), { ...CTX, now: new Date('2026-12-01T00:00:00Z') })
			)
			expect(xml).not.toContain('g:sale_price')
			expect(xml).toContain('<g:custom_label_3>mid</g:custom_label_3>')
		})

		it('still excludes a variant without a regular price, promo or not', () => {
			expect(buildItem(onSale({ price: 0 }), { ...CTX, now: NOW })).toEqual({
				ok: false,
				reason: 'no_price'
			})
		})
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
			'<description><![CDATA[Sunlu PLA Silk — Золотий (Gold)]]></description>'
		)
		expect(built.ok && built.warnings.sort()).toEqual(
			[
				'missing_required_attribute',
				'no_description',
				'no_google_product_category',
				'no_weight'
			].sort()
		)
		expect(built.ok && built.missing_required).toEqual([
			{ key: 'spool_included', label: 'Котушка в комплекті' }
		])
	})

	it('treats an attribute stored empty by the admin form as an unfulfilled requirement', () => {
		const r = row()
		// What the admin form saves for a required attribute left blank: the key is there.
		r.product!.attributes = r.product!.attributes.map(a =>
			a.k === 'spool_included' ? { ...a, v: '   ' } : a
		)

		const built = buildItem(r, CTX)
		expect(built.ok && built.warnings).toContain('missing_required_attribute')
		expect(built.ok && built.missing_required).toEqual([
			{ key: 'spool_included', label: 'Котушка в комплекті' }
		])
	})

	it('labels the gap from the product attribute when the category has no label', () => {
		const r = row()
		r.category!.required_attributes = [{ key: 'diameter', label: '', is_required: true }]
		r.product!.attributes.push({ k: 'diameter', l: 'Діаметр', v: '' })

		const built = buildItem(r, CTX)
		expect(built.ok && built.missing_required).toEqual([{ key: 'diameter', label: 'Діаметр' }])
	})

	it('keeps a non-string attribute value fulfilled — a number is a value', () => {
		const r = row()
		r.category!.required_attributes = [{ key: 'diameter', label: 'Діаметр', is_required: true }]
		r.product!.attributes.push({ k: 'diameter', l: 'Діаметр', v: 0 })

		const built = buildItem(r, CTX)
		expect(built.ok && built.warnings).not.toContain('missing_required_attribute')
		expect(built.ok && built.missing_required).toEqual([])
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
		r.name = 'Sunlu PLA "Rainbow" & <Glow>'
		const xml = xmlOf(buildItem(r, CTX))
		expect(xml).toContain('<title>Sunlu PLA &quot;Rainbow&quot; &amp; &lt;Glow&gt;</title>')
	})
})

describe('title', () => {
	// The SKU's own name, as the site prints it (owner, 2026-11-05): no category name, no
	// diameter or weight composed in, no brand moved about.
	it('is the SKU name as stored', () => {
		const r = row()
		r.name = 'Kingroon PETG (CoPET) 3 кг — Філамент (пластик для 3D-друку) — Чорний (Black)'
		r.category!.name = 'Інша назва категорії'
		expect(xmlOf(buildItem(r, CTX))).toContain(
			'<title>Kingroon PETG (CoPET) 3 кг — Філамент (пластик для 3D-друку) — Чорний (Black)</title>'
		)
	})

	it('caps the title at 150 characters', () => {
		const r = row()
		r.name = `Sunlu ${'Довга назва '.repeat(20)}`
		const title = /<title>(.*)<\/title>/.exec(xmlOf(buildItem(r, CTX)))?.[1] ?? ''
		expect(title.length).toBe(150)
		expect(title.endsWith('…')).toBe(true)
	})
})

describe('productHighlights', () => {
	it('prints one bullet per stored dimension, in a fixed order', () => {
		expect(
			productHighlights([
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
				{ k: 'series', l: 'Серія', v: 'Basic' },
				{ k: 'diametr', l: 'Діаметр', v: '1.75', unit: 'мм' },
				{ k: 'reinforcement', l: 'Армування', v: 'CF' },
				{ k: 'vaha', l: 'Вага філаменту', v: '1', unit: 'кг' },
				{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
				{ k: 'finish', l: 'Ефект поверхні', v: 'Silk' },
				{ k: 'spool_included', l: 'Котушка в комплекті', v: 'Ні (рефіл)' }
			])
		).toEqual([
			'Діаметр: 1.75 мм',
			'Вага філаменту: 1 кг',
			'Тип пластику: PLA',
			'Ефект поверхні: Silk',
			'Армування: CF',
			'Серія: Basic',
			'Котушка в комплекті: Ні (рефіл)'
		])
	})

	it('leaves out brand, colour and the legacy material — each has a field of its own', () => {
		expect(
			productHighlights([
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
				{ k: 'kolir', l: 'Колір', v: 'Чорний' },
				{ k: 'material', l: 'Матеріал', v: 'PLA Silk' }
			])
		).toEqual([])
	})

	it('skips a dimension the admin form stored empty', () => {
		expect(
			productHighlights([
				{ k: 'diametr', l: 'Діаметр', v: '   ', unit: 'мм' },
				{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }
			])
		).toEqual(['Тип пластику: PLA'])
	})
})

describe('typeFamilyLabel', () => {
	const attr = (k: string, v: string) => ({ k, l: k, v })

	it.each([
		[[attr('polymer', 'PLA')], null, 'basic'],
		[[attr('polymer', 'PETG')], null, 'basic'],
		[[attr('polymer', 'PLA'), attr('finish', 'Silk')], null, 'decorative'],
		[[attr('polymer', 'PLA'), attr('reinforcement', 'CF')], null, 'engineering'],
		[[attr('polymer', 'PA6')], null, 'engineering'],
		[[attr('polymer', 'ABS')], null, 'engineering'],
		[[attr('polymer', 'TPU'), attr('finish', 'Matte')], null, 'flex'],
		// Products that predate the taxonomy: only the free-text «Матеріал» is there.
		[[], 'PETG-CF', 'engineering'],
		[[], 'PLA Silk', 'basic'],
		[[attr('finish', '  ')], null, 'basic']
	])('reads %p / %p as %s', (attributes, material, expected) => {
		expect(typeFamilyLabel(attributes, material)).toBe(expected)
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

	it.each([0, 1, 3])(
		'is the head, each item with its newline, and the tail — the former join, %p item(s)',
		count => {
			const ctx = {
				title: 'Fillando',
				link: 'https://fillando.com',
				description: 'Каталог',
				generatedAt: new Date('2026-09-06T10:00:00Z')
			}
			const items = Array.from(
				{ length: count },
				(_, n) => `<item>\n  <g:id>${n}</g:id>\n</item>`
			)
			// The envelope as it was built before the feed was streamed (Plan-0010 D06).
			const former = [
				'<?xml version="1.0" encoding="UTF-8"?>',
				'<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
				'<channel>',
				'<title>Fillando</title>',
				'<link>https://fillando.com</link>',
				'<description>Каталог</description>',
				'<lastBuildDate>Sun, 06 Sep 2026 10:00:00 GMT</lastBuildDate>',
				...items,
				'</channel>',
				'</rss>',
				''
			].join('\n')
			expect(buildFeedXml(items, ctx)).toBe(former)
			expect(feedXmlHead(ctx) + items.map(item => `${item}\n`).join('') + FEED_XML_TAIL).toBe(
				former
			)
		}
	)
})

describe('explicit category attribute requiredness', () => {
	it('keeps optional fields but warns only about empty required fields', () => {
		const r = row()
		r.category!.required_attributes = [
			{ key: 'finish', label: 'Ефект поверхні', is_required: false },
			{ key: 'reinforcement', label: 'Армування', is_required: false },
			{ key: 'diameter', label: 'Діаметр', is_required: true }
		]
		const built = buildItem(r, CTX)
		expect(built.ok && built.missing_required).toEqual([{ key: 'diameter', label: 'Діаметр' }])
		expect(r.category!.required_attributes).toHaveLength(3)
	})
	it.each([undefined, null, 'false', 'true', 0, 1])(
		'rejects invalid stored flag %p, even on an excluded row',
		flag => {
			const r = row()
			r.price = 0
			r.category!.required_attributes[0].is_required = flag as never
			expect(() => buildItem(r, CTX)).toThrow('is_required')
		}
	)
})

it.each([
	['Автомати введення резерву', 'AVR Home', 'Струм', '63 А'],
	['Електроковдри', 'Warm Home', 'Розмір', '150 × 180 см']
])('keeps %s variant suffix without exporting it as colour', (category, name, axis, value) => {
	const r = row()
	r.color = null
	r.v_value = value
	r.product!.name = name
	r.name = `${name} — ${value}`
	r.product!.variant_type = { key: 'axis', label: axis }
	r.product!.attributes = [{ k: 'manufacturer', l: 'Виробник', v: 'Example' }]
	r.category!.name = category
	r.category!.required_attributes = []
	const built = buildItem(r, { ...CTX, productType: category })
	expect(built.ok).toBe(true)
	const xml = xmlOf(built)
	expect(xml).toContain(`— ${value}</title>`)
	expect(xml).not.toContain('<g:color>')
})

describe('v2 rows (Plan-0010 B10)', () => {
	/** An AVR-like v2 row as the typed adapter shapes it. */
	const avr = (): FeedRawRow => ({
		...row(),
		name: 'АВР Bemko — 63 А',
		v_value: '63 А',
		color: null,
		product: {
			name: 'АВР Bemko',
			description_html: '<p>Автомат вводу резерву</p>',
			attributes: [
				{ k: 'brand', l: 'Виробник', v: 'Bemko' },
				{ k: 'poles', l: 'Полюси', v: 'Чотири' },
				{ k: 'voltage', l: 'Напруга', v: '400' }
			],
			variant_type: { key: 'current', label: 'Струм' }
		},
		category: {
			id: '000000000000000000000009',
			name: 'Автомати вводу резерву',
			google_product_category: { id: 500000, path: 'Hardware' },
			required_attributes: [
				{ key: 'poles', label: 'Полюси', is_required: true, unit: null },
				{ key: 'voltage', label: 'Напруга', is_required: false, unit: 'В' }
			]
		},
		semantic: { size: '63 А', material: null, brand: 'Bemko' },
		highlights: ['Полюси: Чотири', 'Напруга: 400 В']
	})

	it('titles by the SKU name, takes the brand and highlights the adapter named', () => {
		const xml = xmlOf(buildItem(avr(), CTX))
		expect(xml).toContain('<title>АВР Bemko — 63 А</title>')
		expect(xml).toContain('<g:brand>Bemko</g:brand>')
		expect(xml).toContain('<g:product_highlight>Полюси: Чотири</g:product_highlight>')
		expect(xml).toContain('<g:product_highlight>Напруга: 400 В</g:product_highlight>')
		expect(xml).toContain('<g:google_product_category>500000</g:google_product_category>')
		expect(xml).toContain('<g:custom_label_0>basic</g:custom_label_0>')
		expect(xml).toContain('<g:custom_label_1>Bemko</g:custom_label_1>')
		expect(xml).toContain('<g:size>63 А</g:size>')
		expect(xml).not.toContain('<g:color>')
	})

	it('never guesses a v2 brand or material from a label (owner, 2026-11-05)', () => {
		// A «Виробник» row is just a characteristic: without a brand entity or a characteristic
		// marked `brand` the SKU is left out and reported, never given a brand.
		expect(buildItem({ ...avr(), semantic: { size: null, material: null } }, CTX)).toEqual({
			ok: false,
			reason: 'missing_brand'
		})
		const filament = xmlOf(
			buildItem({ ...row(), semantic: { material: null, brand: 'Sunlu' } }, CTX)
		)
		expect(filament).not.toContain('<g:material>')
		const marked = xmlOf(
			buildItem({ ...row(), semantic: { material: 'Сталь', brand: 'Sunlu' } }, CTX)
		)
		expect(marked).toContain('<g:material>Сталь</g:material>')
	})

	it('keeps the v1 filament output until the last v1 category is migrated', () => {
		const filament = xmlOf(buildItem(row(), CTX))
		expect(filament).toContain('<g:brand>Sunlu</g:brand>')
		expect(filament).toContain('<g:material>PLA</g:material>')
		expect(filament).toContain('<g:custom_label_0>decorative</g:custom_label_0>')
		expect(filament).not.toContain('<g:size>')
	})
})
