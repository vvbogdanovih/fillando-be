import { sanitizePlainText } from 'src/common/utils/html.utils'
import {
	MANUFACTURER_PATTERNS,
	MATERIAL_PATTERNS,
	pickAttr,
	pickColor
} from 'src/modules/product/product-attribute.helpers'
import type { FeedExclusionReason, FeedRawRow, FeedWarningCode } from './feed.types'

/** Google caps `title` at 150 and `description` at 5000 characters. */
const TITLE_MAX = 150
const DESCRIPTION_MAX = 5000
/** `additional_image_link` accepts at most 10 images per item. */
const ADDITIONAL_IMAGES_MAX = 10

export const GOOGLE_NAMESPACE = 'http://base.google.com/ns/1.0'

/** The five XML metacharacters. Hand-rolled on purpose: the repo has no entity dependency. */
export const xmlEscape = (value: string): string =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

/** CDATA for free text; a literal `]]>` inside is split so it cannot close the section early. */
export const cdata = (value: string): string =>
	`<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`

/** Google's availability enum uses underscores; the spaced form is not in the reference. */
export const availabilityOf = (stock: number): 'in_stock' | 'out_of_stock' =>
	stock > 0 ? 'in_stock' : 'out_of_stock'

/** Stock depth for campaign segmentation — what replaced the margin label (TD-0006 §5.3). */
export const stockDepthLabel = (stock: number): 'deep' | 'low' | 'out' =>
	stock > 10 ? 'deep' : stock > 0 ? 'low' : 'out'

export const priceBandLabel = (price: number): 'budget' | 'mid' | 'premium' =>
	price < 500 ? 'budget' : price <= 1500 ? 'mid' : 'premium'

const truncate = (value: string, max: number) =>
	value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' '
}

/** `sanitizePlainText` re-encodes entities; the description goes into CDATA, so decode them. */
const decodeEntities = (text: string) =>
	text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => ENTITIES[m] ?? m)

/** HTML → plain text for `description`: tags stripped, whitespace collapsed, capped. */
export const descriptionText = (html: string | null | undefined): string => {
	if (!html) return ''
	// Block boundaries become spaces first: stripping tags alone glues «…(еко-пакування)Kingroon…».
	const spaced = html.replace(
		/<\/(p|div|li|h[1-6]|tr|th|td|blockquote|section)>|<br\s*\/?>/gi,
		'$& '
	)
	const text = decodeEntities(sanitizePlainText(spaced)).replace(/\s+/g, ' ').trim()
	return truncate(text, DESCRIPTION_MAX)
}

export type BuiltItem =
	| { ok: true; xml: string; warnings: FeedWarningCode[]; missing_required: string[] }
	| { ok: false; reason: FeedExclusionReason }

export interface BuildItemContext {
	/** `https://fillando.com` — the storefront origin the `link`s point at. */
	frontendUrl: string
	productType: string
}

const tag = (name: string, value: string | number) =>
	`<${name}>${xmlEscape(String(value))}</${name}>`

/**
 * One `<item>` for one ACTIVE variant, or the reason it is left out. Pure: every input is in
 * the row and the context, so a spec can pin each branch without a database.
 *
 * Exclusions are the hard Merchant requirements (price, image, brand, intact references).
 * Everything else degrades to a warning and an omitted field — a feed that is 95% complete is
 * far better than a feed with 5% invented values.
 */
export const buildItem = (row: FeedRawRow, ctx: BuildItemContext): BuiltItem => {
	if (!row.product) return { ok: false, reason: 'dangling_product' }
	if (!row.category) return { ok: false, reason: 'dangling_category' }
	if (!(row.price > 0)) return { ok: false, reason: 'no_price' }
	const images = (row.images ?? []).filter(Boolean)
	if (images.length === 0) return { ok: false, reason: 'no_images' }

	const attributes = Array.isArray(row.product.attributes) ? row.product.attributes : []
	// The «Виробник» attribute. Never the vendor — that is the supplier — and never the shop
	// name: a brand that is not the maker is a typical item-level disapproval without a GTIN.
	const brand = pickAttr(attributes, MANUFACTURER_PATTERNS)
	if (!brand) return { ok: false, reason: 'missing_brand' }

	const warnings: FeedWarningCode[] = []
	const description = descriptionText(row.product.description_html)
	if (!description) warnings.push('no_description')

	const googleCategory = row.category.google_product_category?.id ?? null
	if (!googleCategory) warnings.push('no_google_product_category')

	if (row.weight_g === null || row.weight_g === undefined) warnings.push('no_weight')

	const missingRequired = (row.category.required_attributes ?? [])
		.map(r => r.key)
		.filter(key => !attributes.some(a => a?.k === key))
	if (missingRequired.length > 0) warnings.push('missing_required_attribute')

	// Dictionary colour first (Ukrainian — the feed's language and what the page shows), the
	// legacy heuristic only for the few variants the dictionary has not covered.
	const color =
		row.color?.name_uk ??
		pickColor(row.v_value, attributes, row.product.variant_type ?? undefined)
	const polymer = attributes.find(a => a?.k === 'polymer')
	const material = polymer ? String(polymer.v) : pickAttr(attributes, MATERIAL_PATTERNS)

	const lines: string[] = [
		tag('g:id', row.sku),
		tag('g:item_group_id', row.product_id),
		tag('title', truncate(row.name, TITLE_MAX)),
		`<description>${cdata(description || truncate(row.name, TITLE_MAX))}</description>`,
		tag('link', `${ctx.frontendUrl}/products/${row.slug}`),
		tag('g:image_link', images[0]),
		...images
			.slice(1, 1 + ADDITIONAL_IMAGES_MAX)
			.map(url => tag('g:additional_image_link', url)),
		tag('g:availability', availabilityOf(row.stock ?? 0)),
		tag('g:price', `${row.price.toFixed(2)} UAH`),
		tag('g:brand', brand),
		tag('g:condition', 'new'),
		tag('g:identifier_exists', 'false'),
		tag('g:product_type', ctx.productType)
	]
	if (googleCategory) lines.push(tag('g:google_product_category', googleCategory))
	if (color) lines.push(tag('g:color', color))
	if (material) lines.push(tag('g:material', material))
	if (row.weight_g !== null && row.weight_g !== undefined) {
		lines.push(
			tag('g:shipping_weight', `${(row.weight_g / 1000).toFixed(3).replace(/\.?0+$/, '')} kg`)
		)
	}
	lines.push(
		tag('g:custom_label_0', row.category.name),
		tag('g:custom_label_1', brand),
		tag('g:custom_label_2', stockDepthLabel(row.stock ?? 0)),
		tag('g:custom_label_3', priceBandLabel(row.price))
	)

	return {
		ok: true,
		xml: `<item>\n${lines.map(l => `  ${l}`).join('\n')}\n</item>`,
		warnings,
		missing_required: missingRequired
	}
}

export interface BuildFeedContext {
	title: string
	link: string
	description: string
	generatedAt: Date
}

/** The RSS 2.0 envelope Google, Bing and Meta all read. */
export const buildFeedXml = (items: string[], ctx: BuildFeedContext): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<rss version="2.0" xmlns:g="${GOOGLE_NAMESPACE}">`,
		'<channel>',
		tag('title', ctx.title),
		tag('link', ctx.link),
		tag('description', ctx.description),
		tag('lastBuildDate', ctx.generatedAt.toUTCString()),
		...items,
		'</channel>',
		'</rss>',
		''
	].join('\n')
