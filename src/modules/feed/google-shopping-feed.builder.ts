import { sanitizePlainText } from 'src/common/utils/html.utils'
import {
	DIAMETER_PATTERNS,
	FILAMENT_WEIGHT_PATTERNS,
	MANUFACTURER_PATTERNS,
	materialOf,
	matchesAttrLabel,
	pickAttr,
	pickColor
} from 'src/modules/product/product-attribute.helpers'
import { toPublicAttributes } from 'src/modules/product/product-public.mappers'
import type {
	FeedAttribute,
	FeedExclusionReason,
	FeedRawRow,
	FeedRequiredAttributeRef,
	FeedWarningCode
} from './feed.types'
import { activePromo } from 'src/modules/product/promo-pricing'

/** Google caps `title` at 150 and `description` at 5000 characters. */
const TITLE_MAX = 150
const DESCRIPTION_MAX = 5000
/** `additional_image_link` accepts at most 10 images per item. */
const ADDITIONAL_IMAGES_MAX = 10
/** `product_highlight` accepts at most 10 bullets per item, 150 characters each. */
const HIGHLIGHTS_MAX = 10
const HIGHLIGHT_MAX = 150

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

/**
 * What kind of filament this is — the segmentation axis `custom_label_0` carries.
 *
 * It used to hold the category name, which is the same word on every row while the shop sells
 * one category, so Shopping had nothing to subdivide by (Google Ads plan, 21.09.2026). These
 * four groups bid differently: commodity PLA/PETG competes on price, decorative and engineering
 * filament does not.
 */
export type TypeFamily = 'basic' | 'decorative' | 'engineering' | 'flex'

/** Polymers bought for a job rather than for looks. Commodity PLA and PETG are deliberately out. */
const ENGINEERING_POLYMERS = new Set(['ABS', 'ASA', 'PA', 'PA6', 'PA12', 'PC', 'PET', 'PPA', 'PPS'])

/** «PETG-CF», «PLA CF» — carbon or glass fill written into a legacy free-text material value. */
const REINFORCED_MATERIAL = /(^|[\s\-/])(cf|gf)([\s\-/]|$)/i

/**
 * Read from the TD-0002 dimensions (`reinforcement`, `polymer`, `finish`), not from the product
 * name: those are admin-controlled values, a name is prose. `materialFallback` is the legacy
 * free-text «Матеріал» value, used only where a product predates the taxonomy.
 */
export const typeFamilyLabel = (
	attributes: FeedAttribute[],
	materialFallback: string | null
): TypeFamily => {
	const filled = (key: string) => attributes.find(a => a?.k === key && !isAttrValueEmpty(a.v))
	// Reinforcement first: PLA-CF is engineering filament even though its polymer is the commodity one.
	if (filled('reinforcement')) return 'engineering'
	if (materialFallback && REINFORCED_MATERIAL.test(materialFallback)) return 'engineering'
	const polymer = String(filled('polymer')?.v ?? materialFallback ?? '')
		.trim()
		.split(/[\s\-/]+/)[0]
		.toUpperCase()
	if (polymer === 'TPU' || polymer === 'TPE') return 'flex'
	if (ENGINEERING_POLYMERS.has(polymer)) return 'engineering'
	if (filled('finish')) return 'decorative'
	return 'basic'
}

/** Stock depth for campaign segmentation — what replaced the margin label (TD-0006 §5.3). */
export const stockDepthLabel = (stock: number): 'deep' | 'low' | 'out' =>
	stock > 10 ? 'deep' : stock > 0 ? 'low' : 'out'

export const priceBandLabel = (price: number): 'budget' | 'mid' | 'premium' =>
	price < 500 ? 'budget' : price <= 1500 ? 'mid' : 'premium'

/** Units sold in the trailing window (PAID orders) that make a variant a bestseller / popular. */
export const SALES_WINDOW_DAYS = 90
export const BESTSELLER_UNITS = 10
export const POPULAR_UNITS = 3

export const salesVelocityLabel = (unitsSold: number): 'bestseller' | 'popular' | 'standard' =>
	unitsSold >= BESTSELLER_UNITS
		? 'bestseller'
		: unitsSold >= POPULAR_UNITS
			? 'popular'
			: 'standard'

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

/**
 * A required attribute is fulfilled only when it carries a value. The admin form stores an
 * unfilled one as `{ k: 'diameter', l: 'Діаметр', v: '' }`, so the key being present proves
 * nothing — TD-0006 §5.3 warns about an unfulfilled `required_attributes`, not a missing key.
 *
 * The value is not always a string: `0` and `false` are values, an array is empty only when
 * every element is, and anything else is taken as filled rather than guessed at.
 */
export const isAttrValueEmpty = (value: unknown): boolean => {
	if (value === null || value === undefined) return true
	if (typeof value === 'string') return value.trim() === ''
	if (Array.isArray(value)) return value.every(isAttrValueEmpty)
	return false
}

/** «1.75» with the category's «мм» → «1.75 мм»; a value whose dimension has no unit stands alone. */
const formatSpec = (attribute: FeedAttribute | null | undefined): string | null => {
	if (!attribute || isAttrValueEmpty(attribute.v)) return null
	const value = String(attribute.v).trim()
	const unit = attribute.unit?.trim()
	return unit ? `${value} ${unit}` : value
}

/**
 * The dimensions a `product_highlight` bullet is worth spending on, in the order Google shows
 * them. Brand, colour and the legacy «Матеріал» are left out: the first two have fields of their
 * own and the third repeats `polymer`.
 */
const HIGHLIGHT_DIMENSIONS: ReadonlyArray<(attribute: FeedAttribute) => boolean> = [
	a => matchesAttrLabel(a, DIAMETER_PATTERNS),
	a => a.k === 'vaha' || matchesAttrLabel(a, FILAMENT_WEIGHT_PATTERNS),
	a => a.k === 'polymer',
	a => a.k === 'finish',
	a => a.k === 'reinforcement',
	a => a.k === 'series',
	a => a.k === 'spool_included'
]

/**
 * `g:product_highlight` — the bullets Google prints on the product's Shopping page. Built from
 * stored attributes only, so a highlight can never claim something the specification table does
 * not (TD-0006 §5.3: degrade, never invent).
 */
export const productHighlights = (attributes: FeedAttribute[]): string[] => {
	const used = new Set<FeedAttribute>()
	const highlights: string[] = []
	for (const matches of HIGHLIGHT_DIMENSIONS) {
		const attribute = attributes.find(
			a => a && !used.has(a) && !isAttrValueEmpty(a.v) && matches(a)
		)
		if (!attribute) continue
		used.add(attribute)
		const label = attribute.l?.trim()
		const value = formatSpec(attribute)
		if (!label || !value) continue
		highlights.push(truncate(`${label}: ${value}`, HIGHLIGHT_MAX))
		if (highlights.length === HIGHLIGHTS_MAX) break
	}
	return highlights
}

export type BuiltItem =
	| {
			ok: true
			xml: string
			warnings: FeedWarningCode[]
			missing_required: FeedRequiredAttributeRef[]
	  }
	| { ok: false; reason: FeedExclusionReason }

export interface BuildItemContext {
	/** `https://fillando.com` — the storefront origin the `link`s point at. */
	frontendUrl: string
	productType: string
	/**
	 * The product has more than one active variant: the SKU is sent with `g:item_group_id`. A
	 * product without variation is not a group (TD-0013 SEO matrix §4, D04) — counted over active
	 * variants, so the ID comes back by itself once a second colour is added.
	 */
	inGroup: boolean
	/** Units of this variant sold in the trailing window; omitted → 0 → `standard`. */
	unitsSold?: number
	/** The generation instant — decides which promotions are on (TD-0012); omitted → now. */
	now?: Date
}

/**
 * `YYYY-MM-DDThh:mm:ss+00:00` — ISO 8601 in UTC, as Merchant accepts for
 * `sale_price_effective_date`. Seconds are kept: a window that starts at 12:00:10 and ends at
 * 12:00:50 would otherwise read `12:00/12:00`, which Google rejects as a start that is not before
 * its end, and every longer window would end up to a minute early.
 */
export const googleDate = (date: Date): string => `${date.toISOString().slice(0, 19)}+00:00`

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
	// Validate even rows later excluded for price/images: corrupt category data must never
	// silently publish a partial replacement feed. The service retains its previous XML.
	if (row.category) {
		const fields = row.category.required_attributes
		if (
			!Array.isArray(fields) ||
			fields.some(field => !field || typeof field.is_required !== 'boolean')
		) {
			throw new Error(
				`Категорія ${row.category.id}: некоректний is_required. Виконайте міграцію характеристик; фід не оновлено.`
			)
		}
	}
	if (!row.product) return { ok: false, reason: 'dangling_product' }
	if (!row.category) return { ok: false, reason: 'dangling_category' }
	if (!(row.price > 0)) return { ok: false, reason: 'no_price' }
	// The shop's own promotion, from the same rule the page uses — Merchant compares the two.
	const now = ctx.now ?? new Date()
	const promo = activePromo(row, now)
	const images = (row.images ?? []).filter(Boolean)
	if (images.length === 0) return { ok: false, reason: 'no_images' }

	// Units live on the category, so the attributes are joined through the same allowlist the
	// product page uses — the title must print «1.75 мм», not a bare «1.75».
	const attributes: FeedAttribute[] = toPublicAttributes(
		Array.isArray(row.product.attributes) ? row.product.attributes : [],
		row.category.required_attributes
	)
	// A v2 row (the feed adapter fills `semantic`) names its brand explicitly: the brand entity or
	// the characteristic marked `brand` (owner, 2026-11-05). A v1 row keeps the «Виробник» label
	// match until the last v1 category is migrated. Never the vendor — that is the supplier — and
	// never the shop name: a brand that is not the maker is a typical item-level disapproval
	// without a GTIN, so a SKU without a brand is left out and reported, not given one.
	const typed = row.semantic !== undefined
	const brand = typed
		? (row.semantic?.brand ?? null)
		: pickAttr(attributes, MANUFACTURER_PATTERNS)
	if (!brand) return { ok: false, reason: 'missing_brand' }

	const warnings: FeedWarningCode[] = []
	const description = descriptionText(row.product.description_html)
	if (!description) warnings.push('no_description')

	const googleCategory = row.category.google_product_category?.id ?? null
	if (!googleCategory) warnings.push('no_google_product_category')

	if (row.weight_g === null || row.weight_g === undefined) warnings.push('no_weight')

	const missingRequired = row.category.required_attributes
		.filter(r => r.is_required)
		.map(r => ({ required: r, attr: attributes.find(a => a?.k === r.key) }))
		.filter(({ attr }) => !attr || isAttrValueEmpty(attr.v))
		.map(
			({ required, attr }): FeedRequiredAttributeRef => ({
				key: required.key,
				// The category's own label first, the product's copy of it second, the key last.
				label: required.label?.trim() || attr?.l?.trim() || required.key
			})
		)
	if (missingRequired.length > 0) warnings.push('missing_required_attribute')

	// Dictionary colour first (Ukrainian — the feed's language and what the page shows), the
	// legacy heuristic only for the few variants the dictionary has not covered.
	const color =
		row.color?.name_uk ??
		pickColor(row.v_value, attributes, row.product.variant_type ?? undefined)
	// v2: only the characteristic marked `material` (B10), shared with the product page's
	// structured data (F09). v1 keeps its legacy rule until the last v1 category is migrated.
	const material = typed ? (row.semantic?.material ?? null) : materialOf(null, attributes)
	const size = row.semantic?.size ?? null

	// The SKU's own name, as the site prints it — product name, then the variation (owner,
	// 2026-11-05). Nothing from the category or the characteristics is composed into it.
	const title = truncate(row.name, TITLE_MAX)

	const lines: string[] = [
		tag('g:id', row.sku),
		...(ctx.inGroup ? [tag('g:item_group_id', row.product_id)] : []),
		tag('title', title),
		`<description>${cdata(description || title)}</description>`,
		tag('link', `${ctx.frontendUrl}/products/${row.slug}`),
		tag('g:image_link', images[0]),
		...images
			.slice(1, 1 + ADDITIONAL_IMAGES_MAX)
			.map(url => tag('g:additional_image_link', url)),
		tag('g:availability', availabilityOf(row.stock ?? 0)),
		tag('g:price', `${row.price.toFixed(2)} UAH`),
		// Regular price above, sale price here; the window starts at this generation (there is no
		// stored start) and ends with the promo — open-ended promos send no window at all.
		...(promo ? [tag('g:sale_price', `${promo.sale_price.toFixed(2)} UAH`)] : []),
		...(promo?.ends_at
			? [
					tag(
						'g:sale_price_effective_date',
						`${googleDate(now)}/${googleDate(promo.ends_at)}`
					)
				]
			: []),
		tag('g:brand', brand),
		tag('g:condition', 'new'),
		tag('g:identifier_exists', 'false'),
		tag('g:product_type', ctx.productType)
	]
	if (googleCategory) lines.push(tag('g:google_product_category', googleCategory))
	if (color) lines.push(tag('g:color', color))
	if (material) lines.push(tag('g:material', material))
	if (size) lines.push(tag('g:size', size))
	for (const highlight of (row.highlights ?? productHighlights(attributes)).slice(
		0,
		HIGHLIGHTS_MAX
	)) {
		lines.push(tag('g:product_highlight', truncate(highlight, HIGHLIGHT_MAX)))
	}
	if (row.weight_g !== null && row.weight_g !== undefined) {
		lines.push(
			tag('g:shipping_weight', `${(row.weight_g / 1000).toFixed(3).replace(/\.?0+$/, '')} kg`)
		)
	}
	lines.push(
		tag('g:custom_label_0', typeFamilyLabel(attributes, material)),
		tag('g:custom_label_1', brand),
		tag('g:custom_label_2', stockDepthLabel(row.stock ?? 0)),
		// The band is for bidding by what the shopper pays, so it follows the sale price.
		tag('g:custom_label_3', priceBandLabel(promo?.sale_price ?? row.price)),
		tag('g:custom_label_4', salesVelocityLabel(ctx.unitsSold ?? 0))
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

/**
 * The RSS 2.0 envelope up to the first item, newline included. A streamed feed is
 * `feedXmlHead + (item + '\n')… + FEED_XML_TAIL` — byte for byte {@link buildFeedXml}.
 */
export const feedXmlHead = (ctx: BuildFeedContext): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<rss version="2.0" xmlns:g="${GOOGLE_NAMESPACE}">`,
		'<channel>',
		tag('title', ctx.title),
		tag('link', ctx.link),
		tag('description', ctx.description),
		tag('lastBuildDate', ctx.generatedAt.toUTCString()),
		''
	].join('\n')

/** What follows the last item. */
export const FEED_XML_TAIL = '</channel>\n</rss>\n'

/** The RSS 2.0 envelope Google, Bing and Meta all read. */
export const buildFeedXml = (items: string[], ctx: BuildFeedContext): string =>
	feedXmlHead(ctx) + items.map(item => `${item}\n`).join('') + FEED_XML_TAIL
