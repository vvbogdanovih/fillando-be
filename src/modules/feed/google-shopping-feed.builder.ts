import { sanitizePlainText } from 'src/common/utils/html.utils'
import {
	DIAMETER_PATTERNS,
	FILAMENT_WEIGHT_PATTERNS,
	MANUFACTURER_PATTERNS,
	MATERIAL_PATTERNS,
	matchesAttrLabel,
	pickAttr,
	pickAttrEntry,
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

/** Compared, never printed: «1,75 мм» and «1.75 мм» are the same spec written two ways. */
const comparable = (value: string) => value.toLowerCase().replace(/,/g, '.').replace(/\s+/g, ' ')

/**
 * The product name without the brand it starts with, so the title says «Kingroon» once.
 *
 * A name that is nothing but the brand keeps it — «Філамент Kingroon 1.75 мм» still describes
 * something, «Філамент 1.75 мм» does not.
 */
export const stripBrandPrefix = (productName: string, brand: string | null): string => {
	const name = productName.trim()
	const prefix = brand?.trim()
	if (!prefix || !comparable(name).startsWith(comparable(prefix))) return name
	return name.slice(prefix.length).trim() || name
}

/**
 * `title` — «Філамент PLA Silk Kingroon 1.75 мм 1 кг — Золотий».
 *
 * Shopping matches the query against this string, so the words shoppers type have to be in it:
 * «філамент», the diameter, the weight, the Ukrainian colour. The stored variant name carries
 * none of them — it reads «Kingroon PLA Silk — Золотий (Gold)» and spends 43 of the 150
 * characters Google allows (Google Ads plan, 21.09.2026).
 *
 * The type phrase is the product name minus its brand, not the `polymer` attribute: the name is
 * the only place «Silk», «High Speed», «(еко-пакування)» or «для AMS» is written, and that is
 * both what distinguishes two otherwise identical items and what people search for.
 *
 * Every part is skipped when the phrase already contains it, so a product named «PETG (CoPET)
 * 3 кг» is not titled «… 3 кг Kingroon 1.75 мм 3 кг».
 */
export const buildTitle = (input: {
	categoryName: string
	productName: string
	brand: string | null
	color: string | null
	attributes: FeedAttribute[]
}): string => {
	const phrase = stripBrandPrefix(input.productName, input.brand)
	const said = comparable(phrase)
	const parts: string[] = []
	// Anything the name already says is not repeated — «Філамент PETG», never «Філамент Філамент PETG».
	const append = (part: string | null | undefined) => {
		const value = part?.trim()
		if (value && !said.includes(comparable(value))) parts.push(value)
	}
	append(input.categoryName)
	parts.push(phrase)
	append(input.brand)
	append(formatSpec(pickAttrEntry(input.attributes, DIAMETER_PATTERNS)))
	append(formatSpec(pickAttrEntry(input.attributes, FILAMENT_WEIGHT_PATTERNS)))
	const title = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
	return input.color ? `${title} — ${input.color.trim()}` : title
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
	/** Units of this variant sold in the trailing window; omitted → 0 → `standard`. */
	unitsSold?: number
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
	const images = (row.images ?? []).filter(Boolean)
	if (images.length === 0) return { ok: false, reason: 'no_images' }

	// Units live on the category, so the attributes are joined through the same allowlist the
	// product page uses — the title must print «1.75 мм», not a bare «1.75».
	const attributes: FeedAttribute[] = toPublicAttributes(
		Array.isArray(row.product.attributes) ? row.product.attributes : [],
		row.category.required_attributes
	)
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
	const polymer = attributes.find(a => a?.k === 'polymer')
	const material = polymer ? String(polymer.v) : pickAttr(attributes, MATERIAL_PATTERNS)

	const title = truncate(
		buildTitle({
			categoryName: row.category.name,
			productName: row.product.name,
			brand,
			color,
			attributes
		}),
		TITLE_MAX
	)

	const lines: string[] = [
		tag('g:id', row.sku),
		tag('g:item_group_id', row.product_id),
		tag('title', title),
		`<description>${cdata(description || title)}</description>`,
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
	for (const highlight of productHighlights(attributes)) {
		lines.push(tag('g:product_highlight', highlight))
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
		tag('g:custom_label_3', priceBandLabel(row.price)),
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
