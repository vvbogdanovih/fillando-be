import { isDeepStrictEqual } from 'node:util'
import { mongo } from 'mongoose'
import { z } from 'zod'
import { CatalogPatch } from 'src/database/mongoose/repositories/catalog-mutation-journal'
import {
	AttributeContractError,
	AttributeDefinition,
	parseDefinitions,
	validateAttributes
} from './attribute-definitions'
import { purchaseNoticeSchema } from '../product/typed-product'

/**
 * Explicit, reviewed mapping of one v1 product category to the v2 contract (Plan-0010 B04,
 * D02). Nothing here is guessed from labels or values: every key that changes meaning is named.
 */
export const migrationMappingSchema = z.strictObject({
	category_slug: z.string().min(1),
	/** Legacy attribute holding the manufacturer; becomes `products.brand_id` (never the vendor). */
	brand_key: z.string().min(1).nullable(),
	/** Legacy keys whose values are numeric text («1», «1.75») and become numbers. */
	number_keys: z.array(z.string()).default([]),
	/**
	 * Product-level keys that, on a product WITH an axis, are a stale copy of one SKU's value and
	 * are not carried over. On a product without an axis the same key is real description and is
	 * kept as an ordinary characteristic.
	 */
	drop_product_keys: z.array(z.string()).default([]),
	/**
	 * Keys not carried over at all (owner, 2026-11-06): no definition, no value on any product. The
	 * filament's free-text «Матеріал» («PLA Silk Rainbow») repeated what the typed characteristics
	 * hold; its values stay only in the legacy `attributes`.
	 */
	removed_keys: z.array(z.string().min(1)).default([]),
	/** Product-only keys (not in required_attributes) kept as visible, unfiltered text. */
	axis: z
		.strictObject({
			key: z.string().min(1),
			label: z.string().min(1),
			semantic: z.literal('color')
		})
		.nullable(),
	/**
	 * Written once into each product name, before the variation, and so into its SKU names (owner,
	 * 2026-11-05): «Kingroon PETG (CoPET) 3 кг — Філамент (пластик для 3D-друку) — Чорний
	 * (Black)». A name that already says it is kept. It is data of each product from then on —
	 * nothing in the category adds it at read time.
	 */
	product_name_addition: z.string().trim().min(1).max(200).nullable().default(null),
	/**
	 * One colour, the axis (owner, 2026-11-05): a product with a single SKU that has no dictionary
	 * colour takes its colour-axis value from this product characteristic — its text matched to a
	 * dictionary colour by `name_uk` or `name_en`, through `color_aliases` where they differ — so
	 * the characteristic is dropped like on every other product instead of staying a second
	 * «Колір». A text that matches no single dictionary colour stops the plan.
	 */
	single_sku_color_key: z.string().min(1).nullable().default(null),
	color_aliases: z.record(z.string().min(1), z.string().min(1)).default({}),
	/**
	 * The colour of single SKUs that carry none at all, named by the owner (2026-11-06: «Kingroon
	 * Wood PLA» is «Натуральне дерево (Natural Wood)», the two CF filaments «Чорний (Black)»): SKU
	 * code → a dictionary colour by `name_uk` or `name_en`. It wins over `single_sku_color_key`
	 * and puts the SKU on the colour axis the same way. A code that is not such a SKU of this
	 * category stops the plan — a typo would silently leave it without a colour.
	 */
	sku_colors: z.record(z.string().min(1), z.string().min(1)).default({}),
	/** Characteristics listed first, in this order: the product page's table order. */
	definition_order: z.array(z.string().min(1)).default([]),
	/** Characteristics kept as data (exports, brand, material) but not in the page's table. */
	hidden_keys: z.array(z.string().min(1)).default([]),
	/**
	 * Values merged into another value of the same characteristic, `{ key: { from: to } }` — two
	 * spellings of one property (owner, 2026-11-05: «Glow» is «Luminous»). Applied to products and
	 * landing pins; the legacy `attributes` keep the old value as the rollback image.
	 */
	value_aliases: z
		.record(z.string().min(1), z.record(z.string().min(1), z.string().min(1)))
		.default({}),
	/**
	 * Text characteristics turned into a list with the words a shopper reads (owner, 2026-11-05:
	 * «Шовковий (Silk)», not «Silk»): every value a product holds or a landing pins becomes an
	 * option whose id is the value as stored — products, pins and facets keep it — and whose label
	 * is given here, else the value itself. The labels were the storefront's v1 filter map; they
	 * are category data from now on.
	 */
	enum_labels: z
		.record(z.string().min(1), z.record(z.string().min(1), z.string().min(1)))
		.default({}),
	/** What a characteristic means: where the brand and the material are read from. */
	semantics: z.record(z.string().min(1), z.enum(['brand', 'material'])).default({}),
	/**
	 * Purchase notices written onto each product whose characteristic has the value (the refill
	 * warning): from then on the notice is the product's own (owner, 2026-11-05).
	 */
	product_notices: z
		.array(
			z.strictObject({
				key: z.string().min(1),
				value: z.string().min(1),
				title: z.string().min(1).max(120),
				text: z.string().min(1).max(1000),
				badge: z.string().max(40).nullable()
			})
		)
		.default([])
})
export type MigrationMapping = z.infer<typeof migrationMappingSchema>

export class MigrationPlanError extends Error {
	constructor(
		readonly code: string,
		readonly target?: string
	) {
		super(target ? `${code}:${target}` : code)
		this.name = 'MigrationPlanError'
	}
}

type Doc = mongo.Document & { _id: mongo.ObjectId }
export interface MigrationInput {
	category: Doc
	products: Doc[]
	variants: Doc[]
	landings: Doc[]
	/** Active brand entities by exact name, created beforehand by an explicit step. */
	brandsByName: Map<string, mongo.ObjectId>
	/** The colour dictionary, for `single_sku_color_key`. */
	colors?: { _id: mongo.ObjectId; name_uk: string; name_en: string; family: string }[]
	mapping: MigrationMapping
}
export interface MigrationReport {
	category: string
	definitions: { key: string; value_type: string; filter: string | null; required: boolean }[]
	products: number
	products_with_axis: number
	products_without_axis: number
	variants: number
	landings: number
	brands: Record<string, number>
	dropped_product_attributes: Record<string, number>
	/** `removed_keys` → products whose value was not carried over. */
	removed_attributes: Record<string, number>
	/** Products and SKUs whose name gains `product_name_addition`. */
	renamed_products: number
	renamed_variants: number
	/** Products given a purchase notice by `product_notices`. */
	product_notices: number
	/** `key:from→to` → products whose value was merged by `value_aliases`. */
	merged_values: Record<string, number>
	/** SKU code → the dictionary colour (`name_en`) `sku_colors` or `single_sku_color_key` put it on the axis with. */
	colored_skus: Record<string, string>
	/** Key → the options `enum_labels` made of its values. */
	enum_options: Record<string, number>
}

const image = (row: mongo.Document, key: string) =>
	Object.hasOwn(row, key)
		? { exists: true as const, value: row[key] as unknown }
		: { exists: false as const }

/**
 * The journal plan that moves one flat v1 product category to v2 in place: same `_id`, slug,
 * product/SKU ids, SKU codes, slugs, prices and stock. Names change only by the mapping's
 * `product_name_addition` (before the variation); otherwise only additive v2 fields are
 * written; the legacy `required_attributes`, `attributes`, `variant_type`, `v_value`,
 * `color_id`/`color_family` and landing `filters` stay as the rollback image and for consumers
 * that are not adapted yet. Any value that does not fit the mapping stops the plan.
 */
export function buildV2MigrationPlan(input: MigrationInput): {
	patches: CatalogPatch[]
	report: MigrationReport
} {
	const { category, mapping } = input
	if (category.slug !== mapping.category_slug)
		throw new MigrationPlanError('MAPPING_CATEGORY_MISMATCH')
	if (
		(category.kind ?? 'product') !== 'product' ||
		(category.parent_id ?? null) !== null ||
		(category.attribute_contract_version ?? 1) !== 1 ||
		(category.status ?? 'active') !== 'active'
	)
		throw new MigrationPlanError('CATEGORY_NOT_FLAT_V1')
	const legacy = z
		.array(
			z.object({
				key: z.string().min(1),
				label: z.string().min(1),
				is_required: z.boolean(),
				unit: z.string().nullable().optional(),
				filter_type: z.enum(['multi-select', 'range'])
			})
		)
		.parse(category.required_attributes ?? [])

	const numbers = new Set(mapping.number_keys)
	const dropped = new Set(mapping.drop_product_keys)
	const removed = new Set(mapping.removed_keys)
	const definitions: AttributeDefinition[] = []
	for (const row of legacy) {
		if (row.key === mapping.brand_key || removed.has(row.key)) continue
		const number = numbers.has(row.key)
		if (row.filter_type === 'range' && !number)
			throw new MigrationPlanError('RANGE_REQUIRES_NUMBER', row.key)
		definitions.push({
			key: row.key,
			label: row.label,
			value_type: number ? 'number' : 'string',
			unit: row.unit?.trim() || null,
			is_required: row.is_required,
			filter_enabled: true,
			filter_type: row.filter_type,
			visible_in_specs: true,
			order: definitions.length,
			multiple: false,
			semantic: 'generic',
			options: []
		})
	}
	// Product-only keys keep their text, visible but not filterable (no facet nobody configured).
	const known = new Set([...legacy.map(row => row.key), mapping.brand_key])
	const productOnly = new Map<string, string>()
	for (const product of input.products)
		for (const attribute of (product.attributes ?? []) as { k: string; l: string }[])
			if (!known.has(attribute.k) && !productOnly.has(attribute.k))
				productOnly.set(attribute.k, attribute.l)
	// A removed key must exist: a misspelt one would silently keep the characteristic.
	for (const key of removed)
		if (!known.has(key) && !productOnly.has(key))
			throw new MigrationPlanError('MAPPING_UNKNOWN_KEY', key)
	for (const key of removed) productOnly.delete(key)
	for (const [key, label] of [...productOnly].sort(([a], [b]) => a.localeCompare(b)))
		definitions.push({
			key,
			label,
			value_type: numbers.has(key) ? 'number' : 'string',
			unit: null,
			is_required: false,
			filter_enabled: false,
			filter_type: null,
			visible_in_specs: true,
			order: definitions.length,
			multiple: false,
			semantic: 'generic',
			options: []
		})
	if (mapping.axis) {
		if (definitions.some(row => row.key === mapping.axis!.key))
			throw new MigrationPlanError('AXIS_KEY_IN_USE', mapping.axis.key)
		// The colour axis is filtered by dictionary family, never by raw id: no attribute facet.
		// Required, as every variation is (owner, 2026-11-06): a product without a colour stops the
		// plan — name it in `sku_colors`.
		definitions.push({
			key: mapping.axis.key,
			label: mapping.axis.label,
			value_type: 'string',
			unit: null,
			is_required: true,
			filter_enabled: false,
			filter_type: null,
			visible_in_specs: true,
			order: definitions.length,
			multiple: false,
			semantic: mapping.axis.semantic,
			options: []
		})
	}
	// Keys that appear more than once on a product were legacy multivalue.
	for (const product of input.products) {
		const counts = new Map<string, number>()
		for (const attribute of (product.attributes ?? []) as { k: string }[])
			counts.set(attribute.k, (counts.get(attribute.k) ?? 0) + 1)
		for (const [key, count] of counts) {
			const definition = definitions.find(row => row.key === key)
			if (definition && count > 1) definition.multiple = true
		}
	}
	// One order and one visibility switch (owner, 2026-11-05): the product page reads the
	// definitions themselves, so the mapping sets them here — there is no category presentation.
	const definitionOf = (key: string) => {
		const found = definitions.find(row => row.key === key)
		if (!found) throw new MigrationPlanError('MAPPING_UNKNOWN_KEY', key)
		return found
	}
	for (const key of mapping.hidden_keys) definitionOf(key).visible_in_specs = false
	for (const [key, semantic] of Object.entries(mapping.semantics))
		definitionOf(key).semantic = semantic
	const first = mapping.definition_order.map(definitionOf)
	definitions.splice(
		0,
		definitions.length,
		...first,
		...definitions.filter(row => !first.includes(row))
	)
	definitions.forEach((row, index) => (row.order = index))
	for (const notice of mapping.product_notices) definitionOf(notice.key)
	for (const key of Object.keys(mapping.value_aliases)) definitionOf(key)
	const alias = (key: string, value: unknown) =>
		typeof value === 'string' ? (mapping.value_aliases[key]?.[value] ?? value) : value
	for (const [key, labels] of Object.entries(mapping.enum_labels)) {
		const definition = definitionOf(key)
		if (definition.value_type !== 'string' || numbers.has(key))
			throw new MigrationPlanError('ENUM_REQUIRES_TEXT', key)
		const held = new Set<string>()
		for (const product of input.products)
			for (const row of (product.attributes ?? []) as { k: string; v: unknown }[])
				if (row.k === key) held.add(String(alias(key, row.v)))
		for (const landing of input.landings)
			for (const value of ((landing.filters ?? {}) as Record<string, unknown[]>)[key] ?? [])
				held.add(String(alias(key, value)))
		// By value, the order the storefront's facets list them in.
		const ids = [...held].sort()
		definition.value_type = 'enum'
		definition.options = ids.map((id, order) => ({ id, label: labels[id] ?? id, order }))
	}
	const notices = mapping.product_notices.map(row => ({
		...row,
		notice: purchaseNoticeSchema.parse({ title: row.title, text: row.text, badge: row.badge })
	}))
	const checked = parseDefinitions(definitions)

	const toValue = (key: string, value: unknown, target: string) => {
		if (!numbers.has(key)) return value
		const text = typeof value === 'number' ? String(value) : value
		if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text.trim()))
			throw new MigrationPlanError('NOT_A_NUMBER', `${target}:${key}`)
		return Number(text.trim())
	}

	const patches: CatalogPatch[] = []
	const report: MigrationReport = {
		category: String(category.slug),
		definitions: checked.map(row => ({
			key: row.key,
			value_type: row.value_type,
			filter: row.filter_type,
			required: row.is_required
		})),
		products: input.products.length,
		products_with_axis: 0,
		products_without_axis: 0,
		variants: 0,
		landings: input.landings.length,
		brands: {},
		dropped_product_attributes: {},
		removed_attributes: {},
		renamed_products: 0,
		renamed_variants: 0,
		product_notices: 0,
		merged_values: {},
		colored_skus: {},
		enum_options: Object.fromEntries(
			definitions
				.filter(row => row.value_type === 'enum')
				.map(row => [row.key, row.options.length])
		)
	}
	const categoryId = String(category._id)
	const set = (row: Doc, desired: mongo.Document) =>
		Object.fromEntries(
			Object.entries(desired).map(([key, value]: [string, unknown]) => [
				key,
				{ before: image(row, key), after: { exists: true as const, value } }
			])
		)
	/** Dropped keys some product keeps as real description (it has no axis). */
	const keptDropped = new Set<string>()

	const variantsByProduct = new Map<string, Doc[]>()
	// A misspelt code is named as such before anything else complains about its product.
	const codes = new Set(input.variants.map(row => String(row.sku)))
	const unknownSkus = Object.keys(mapping.sku_colors).filter(sku => !codes.has(sku))
	if (unknownSkus.length)
		throw new MigrationPlanError('MAPPING_UNKNOWN_SKU', unknownSkus.join(','))
	for (const variant of input.variants) {
		if (String(variant.category_id) !== categoryId)
			throw new MigrationPlanError('VARIANT_CATEGORY_MISMATCH', String(variant._id))
		const list = variantsByProduct.get(String(variant.product_id)) ?? []
		list.push(variant)
		variantsByProduct.set(String(variant.product_id), list)
	}
	for (const product of input.products) {
		const id = String(product._id)
		if (String(product.category_id) !== categoryId)
			throw new MigrationPlanError('PRODUCT_CATEGORY_MISMATCH', id)
		const own = variantsByProduct.get(id) ?? []
		if (!own.length) throw new MigrationPlanError('PRODUCT_WITHOUT_VARIANTS', id)
		variantsByProduct.delete(id)
		const colored = own.filter(row => row.color_id instanceof mongo.ObjectId)
		// A single SKU never given a dictionary colour: the owner's `sku_colors`, else its
		// product-level «Колір», names it.
		let assigned: NonNullable<MigrationInput['colors']>[number] | null = null
		const named = own.filter(row => Object.hasOwn(mapping.sku_colors, String(row.sku)))
		for (const row of named)
			if (own.length !== 1 || colored.length)
				throw new MigrationPlanError('SKU_COLOR_NOT_APPLICABLE', String(row.sku))
		const colourText = named.length
			? mapping.sku_colors[String(named[0].sku)]
			: ((product.attributes ?? []) as { k: string; v: unknown }[]).find(
					row => row.k === mapping.single_sku_color_key
				)?.v
		if (mapping.axis && own.length === 1 && !colored.length && typeof colourText === 'string') {
			const wanted = mapping.color_aliases[colourText] ?? colourText
			const matches = (input.colors ?? []).filter(
				row => row.name_uk === wanted || row.name_en === wanted
			)
			if (matches.length !== 1)
				throw new MigrationPlanError('COLOR_NOT_IN_DICTIONARY', `${id}:${colourText}`)
			assigned = matches[0]
		}
		let axis: { key: string } | null
		if (mapping.axis && (colored.length === own.length || assigned))
			axis = { key: mapping.axis.key }
		else if (own.length === 1 && colored.length === 0) axis = null
		else throw new MigrationPlanError('AXIS_MAPPING_REQUIRED', id)
		if (axis) {
			const ids = assigned ? [String(assigned._id)] : colored.map(row => String(row.color_id))
			if (new Set(ids).size !== ids.length)
				throw new MigrationPlanError('DUPLICATE_AXIS_VALUE', id)
			report.products_with_axis++
		} else report.products_without_axis++

		const attributes: { k: string; v: unknown }[] = []
		let brand: mongo.ObjectId | null = null
		for (const attribute of (product.attributes ?? []) as { k: string; v: unknown }[]) {
			if (attribute.k === mapping.brand_key) {
				const found = input.brandsByName.get(String(attribute.v).trim())
				if (!found) throw new MigrationPlanError('BRAND_NOT_MAPPED', String(attribute.v))
				if (brand && !brand.equals(found))
					throw new MigrationPlanError('MULTIPLE_BRANDS', id)
				brand = found
				report.brands[String(attribute.v).trim()] =
					(report.brands[String(attribute.v).trim()] ?? 0) + 1
				continue
			}
			if (removed.has(attribute.k)) {
				report.removed_attributes[attribute.k] =
					(report.removed_attributes[attribute.k] ?? 0) + 1
				continue
			}
			if (axis && dropped.has(attribute.k)) {
				report.dropped_product_attributes[attribute.k] =
					(report.dropped_product_attributes[attribute.k] ?? 0) + 1
				continue
			}
			if (dropped.has(attribute.k)) keptDropped.add(attribute.k)
			const merged = alias(attribute.k, attribute.v)
			if (merged !== attribute.v) {
				const rule = `${attribute.k}:${String(attribute.v)}→${String(merged)}`
				report.merged_values[rule] = (report.merged_values[rule] ?? 0) + 1
			}
			const value = toValue(attribute.k, merged, id)
			// Two spellings merged on one product leave one value, not a repeated one.
			if (!attributes.some(row => row.k === attribute.k && row.v === value))
				attributes.push({ k: attribute.k, v: value })
		}
		if (mapping.brand_key && !brand) throw new MigrationPlanError('BRAND_MISSING', id)
		let attributes_v2: ReturnType<typeof validateAttributes>
		try {
			// Active catalogue: every required characteristic must already be there.
			attributes_v2 = validateAttributes(checked, attributes, {
				active: true,
				axisKey: axis?.key
			})
		} catch (error) {
			if (error instanceof AttributeContractError)
				throw new MigrationPlanError(`ATTRIBUTE_${error.code}`, `${id}:${error.field}`)
			throw error
		}
		const notice = notices.find(row =>
			attributes.some(
				attribute => attribute.k === row.key && String(attribute.v) === row.value
			)
		)?.notice
		if (notice) report.product_notices++
		const addition = mapping.product_name_addition
		const productName = String(product.name)
		const name =
			!addition || productName.includes(addition)
				? productName
				: `${productName} — ${addition}`
		if (name !== productName) report.renamed_products++
		patches.push({
			collection: 'products',
			id,
			fields: set(product, {
				attributes_v2,
				variant_axis: axis,
				...(brand ? { brand_id: brand } : {}),
				...(notice ? { purchase_notice: notice } : {}),
				...(name !== productName ? { name } : {})
			})
		})
		for (const variant of own) {
			report.variants++
			// A SKU name is the product name, then « — » and the variation: the addition goes in
			// between. A SKU named otherwise is not guessed at.
			const variantName = String(variant.name)
			let renamed =
				name === productName
					? variantName
					: variantName === productName
						? name
						: variantName.startsWith(`${productName} — `)
							? name + variantName.slice(productName.length)
							: null
			if (renamed === null)
				throw new MigrationPlanError('VARIANT_NAME_NOT_PRODUCT_NAME', String(variant._id))
			// Newly on the colour axis: the SKU name ends with its colour, as every other SKU's
			// («… — Чорний (Black)», the dictionary form), and the legacy colour fields every reader
			// still uses are set as the typed editor sets them when it recolours a SKU.
			const label = assigned
				? assigned.name_uk === assigned.name_en
					? assigned.name_uk
					: `${assigned.name_uk} (${assigned.name_en})`
				: null
			if (label && !renamed.endsWith(` — ${label}`)) renamed = `${renamed} — ${label}`
			if (assigned) report.colored_skus[String(variant.sku)] = assigned.name_en
			if (renamed !== variantName) report.renamed_variants++
			patches.push({
				collection: 'product_variants',
				id: String(variant._id),
				fields: set(variant, {
					variant_value: assigned
						? String(assigned._id)
						: axis
							? String(variant.color_id)
							: null,
					...(assigned
						? {
								color_id: assigned._id,
								color_family: assigned.family,
								v_value: assigned.name_en
							}
						: {}),
					...(renamed !== variantName ? { name: renamed } : {})
				})
			})
		}
	}
	if (variantsByProduct.size)
		throw new MigrationPlanError('ORPHAN_VARIANTS', [...variantsByProduct.keys()].join(','))

	const filterable = new Map(checked.filter(row => row.filter_enabled).map(row => [row.key, row]))
	for (const landing of input.landings) {
		const id = String(landing._id)
		const legacyFilters = z.record(z.string(), z.array(z.string())).parse(landing.filters ?? {})
		const attributes: { key: string; values: (string | number)[] }[] = []
		let colorFamilies: string[] = []
		for (const [key, values] of Object.entries(legacyFilters).sort(([a], [b]) =>
			a.localeCompare(b)
		)) {
			if (!values.length) continue
			if (key === 'color_family') {
				if (!mapping.axis) throw new MigrationPlanError('LANDING_COLOR_WITHOUT_AXIS', id)
				colorFamilies = [...values].sort()
				continue
			}
			if (!filterable.has(key))
				throw new MigrationPlanError('LANDING_KEY_NOT_FILTERABLE', `${id}:${key}`)
			attributes.push({
				key,
				values: [
					...new Set(
						values.map(value => toValue(key, alias(key, value), id) as string | number)
					)
				]
			})
		}
		const filters_v2 = {
			attributes,
			category_ids: [],
			brand_ids: [],
			color_families: colorFamilies
		}
		patches.push({
			collection: 'landings',
			id,
			fields: set(landing, { filters_v2, contract_version: 2 })
		})
	}
	// A dropped key no product keeps would be an empty second definition beside the axis (a
	// second «Колір», owner 2026-11-05): it is not created, and the order closes the gap.
	const definitionsKept = parseDefinitions(
		checked
			.filter(row => !dropped.has(row.key) || keptDropped.has(row.key))
			.map((row, index) => ({ ...row, order: index }))
	)
	report.definitions = definitionsKept.map(row => ({
		key: row.key,
		value_type: row.value_type,
		filter: row.filter_type,
		required: row.is_required
	}))
	patches.unshift({
		collection: 'categories',
		id: categoryId,
		fields: set(category, {
			kind: 'product',
			parent_id: null,
			status: 'active',
			attribute_contract_version: 2,
			attribute_definitions: definitionsKept
		})
	})
	if (patches.length > 500) throw new MigrationPlanError('PLAN_TOO_LARGE')
	// A target that already carries a different v2 value was changed by someone else: stop
	// instead of overwriting it. Equal values are fine — the journal treats them as applied.
	for (const patch of patches)
		for (const [field, change] of Object.entries(patch.fields)) {
			// A rename changes a field every product and SKU already has, on purpose; a SKU put on
			// the colour axis fills colour fields that were empty.
			if (field === 'name') continue
			const before = change.before
			if (
				['color_id', 'color_family', 'v_value'].includes(field) &&
				(!before.exists || before.value == null)
			)
				continue
			if (
				before.exists &&
				!isDeepStrictEqual(
					before.value,
					change.after.exists ? change.after.value : undefined
				)
			)
				throw new MigrationPlanError(
					'TARGET_ALREADY_HAS_V2_FIELD',
					`${patch.collection}:${patch.id}:${field}`
				)
		}
	return { patches, report }
}
