import {
	AttributeDefinition,
	validateAttributes,
	validateVariantValue
} from './attribute-definitions'
import { parseAttributeFilters } from './category-attribute-filters'

/**
 * Exact per-key usage of a v2 product category's characteristics (Plan-0010 F03/B03).
 *
 * Replaces the conservative «any product, SKU or landing in the category locks every definition»
 * rule: a change is judged against what actually holds or pins this key. Computed under the
 * catalogue gate by the writer, and read by the admin editor through the same function.
 */
export interface UsageCount {
	products: number
	variants: number
	landings: number
}
export interface KeyUsage extends UsageCount {
	/** Landings pinning the key as an attribute filter (colour families are not counted here). */
	pins: number
	/** Products holding no value for the key, neither as a characteristic nor as their axis. */
	missing: number
	/** Usage of each enum option id. */
	options: Record<string, UsageCount>
}
export interface DefinitionUsage {
	/** Every product of the category. */
	products: number
	keys: Record<string, KeyUsage>
}
export interface CategoryProductRow {
	id: string
	attributes_v2: unknown
	variant_axis: unknown
}
export interface CategoryVariantRow {
	id: string
	product_id: string
	variant_value: unknown
}
export interface CategoryLandingRow {
	id: string
	filters_v2: unknown
}
export interface CategoryData {
	products: CategoryProductRow[]
	variants: CategoryVariantRow[]
	landings: CategoryLandingRow[]
}

export type DefinitionChangeCode =
	| 'DEFINITION_IN_USE'
	| 'DEFINITION_TYPE_LOCKED'
	| 'DEFINITION_UNIT_LOCKED'
	| 'OPTION_IN_USE'
	| 'REQUIRED_VALUES_MISSING'
	| 'AXIS_REQUIRED'
	| 'FILTER_PINNED'
	| 'DEFINITION_CHANGE_INVALIDATES_DATA'

/** A refused change, with what it would break: the editor shows these counts. */
export class DefinitionChangeError extends Error {
	constructor(
		readonly code: DefinitionChangeCode,
		readonly key: string | null,
		readonly label: string | null,
		readonly usage: UsageCount,
		readonly option: { id: string; label: string } | null = null
	) {
		super(`${code}: ${key ?? '*'}`)
		this.name = 'DefinitionChangeError'
	}
}

const axisKeyOf = (value: unknown) =>
	value && typeof value === 'object' && typeof (value as { key?: unknown }).key === 'string'
		? (value as { key: string }).key
		: undefined
const entriesOf = (value: unknown): { k: string; v: unknown }[] =>
	Array.isArray(value)
		? (value as unknown[]).filter(
				(entry): entry is { k: string; v: unknown } =>
					!!entry &&
					typeof entry === 'object' &&
					typeof (entry as { k?: unknown }).k === 'string'
			)
		: []
/** A stored scalar as a map key; anything else (malformed data) is no option of any key. */
const scalarKey = (value: unknown) =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: null
const stringList = (value: unknown) =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
interface Pins {
	attributes: { key: string; values: unknown[] }[]
	color_families: string[]
}
const pinsOf = (value: unknown): Pins => {
	const filters = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	return {
		attributes: (Array.isArray(filters.attributes) ? (filters.attributes as unknown[]) : [])
			.filter(
				(pin): pin is { key: string; values?: unknown } =>
					!!pin &&
					typeof pin === 'object' &&
					typeof (pin as { key?: unknown }).key === 'string'
			)
			.map(pin => ({
				key: pin.key,
				values: Array.isArray(pin.values) ? (pin.values as unknown[]) : []
			})),
		color_families: stringList(filters.color_families)
	}
}
/** Who holds or pins each key of `definitions`. Unknown keys are ignored. */
export function definitionUsage(
	definitions: readonly AttributeDefinition[],
	data: CategoryData
): DefinitionUsage {
	const keys: Record<string, KeyUsage> = {}
	for (const definition of definitions)
		keys[definition.key] = {
			products: 0,
			variants: 0,
			landings: 0,
			pins: 0,
			missing: 0,
			options: Object.fromEntries(
				definition.options.map(option => [
					option.id,
					{ products: 0, variants: 0, landings: 0 }
				])
			)
		}
	const axisOf = new Map<string, string | undefined>()
	for (const product of data.products) {
		const axis = axisKeyOf(product.variant_axis)
		axisOf.set(product.id, axis)
		const held = new Set<string>()
		const optionsHeld = new Map<string, Set<string>>()
		for (const entry of entriesOf(product.attributes_v2)) {
			held.add(entry.k)
			if (typeof entry.v === 'string')
				optionsHeld.set(entry.k, (optionsHeld.get(entry.k) ?? new Set()).add(entry.v))
		}
		if (axis) held.add(axis)
		for (const [key, usage] of Object.entries(keys)) {
			if (!held.has(key)) {
				usage.missing++
				continue
			}
			usage.products++
			for (const option of optionsHeld.get(key) ?? [])
				if (usage.options[option]) usage.options[option].products++
		}
	}
	const axisProductsByOption = new Map<string, Set<string>>()
	for (const variant of data.variants) {
		const axis = axisOf.get(variant.product_id)
		if (!axis || !keys[axis] || variant.variant_value == null) continue
		keys[axis].variants++
		const value = scalarKey(variant.variant_value)
		const option = value === null ? undefined : keys[axis].options[value]
		if (!option) continue
		option.variants++
		// A product carrying the option only on its SKUs still holds it.
		const id = `${axis}:${value}`
		const products = axisProductsByOption.get(id) ?? new Set()
		if (!products.has(variant.product_id)) {
			products.add(variant.product_id)
			option.products++
		}
		axisProductsByOption.set(id, products)
	}
	const colourAxis = definitions.find(definition => definition.semantic === 'color')?.key
	for (const landing of data.landings) {
		const pins = pinsOf(landing.filters_v2)
		const touched = new Set<string>()
		for (const pin of pins.attributes) {
			const usage = keys[pin.key]
			if (!usage || touched.has(pin.key)) continue
			touched.add(pin.key)
			usage.pins++
			usage.landings++
			for (const value of new Set(pin.values.map(String)))
				if (usage.options[value]) usage.options[value].landings++
		}
		// Colour-family pins need a colour axis: they depend on that definition.
		if (pins.color_families.length && colourAxis && !touched.has(colourAxis))
			keys[colourAxis].landings++
	}
	return { products: data.products.length, keys }
}

const used = (usage: UsageCount) => usage.products + usage.variants + usage.landings > 0
const count = (usage: KeyUsage) => ({
	products: usage.products,
	variants: usage.variants,
	landings: usage.landings
})

/**
 * Changes allowed on a draft and a published category alike: renames, new optional
 * characteristics, labels, order, the unit of a key no product or SKU holds a value of, spec
 * visibility, filter flags of unpinned keys, enum options (added, renamed, reordered; an unused one
 * removed). Refused with the counts the admin needs: a type/cardinality/meaning change or removal
 * of a key something holds or pins, a unit change of a key a product or SKU holds a value of (the
 * stored 1000 would silently become «1000 кг»; values are never converted — owner decision
 * 31.10.2026), removal of a used option, a filter change under landing pins, and — in a published
 * category, where every product must stay complete — a requirement that products cannot meet yet.
 */
export function checkDefinitionChange(
	before: readonly AttributeDefinition[],
	next: readonly AttributeDefinition[],
	usage: DefinitionUsage,
	options: { published: boolean }
) {
	const nextByKey = new Map(next.map(definition => [definition.key, definition]))
	for (const old of before) {
		const keyUsage = usage.keys[old.key]
		const replacement = nextByKey.get(old.key)
		if (!replacement) {
			if (used(keyUsage))
				throw new DefinitionChangeError(
					'DEFINITION_IN_USE',
					old.key,
					old.label,
					count(keyUsage)
				)
			continue
		}
		// The meaning («Бренд», «Матеріал», «Розмір») only says where the page, the feed and the
		// exports read a value, so a used key may change it (owner, 2026-11-08) — except into or out
		// of the colour, which is the SKU's dictionary colour, another kind of value.
		const colourChange =
			old.semantic !== replacement.semantic &&
			(old.semantic === 'color' || replacement.semantic === 'color')
		if (
			used(keyUsage) &&
			(old.value_type !== replacement.value_type ||
				old.multiple !== replacement.multiple ||
				colourChange)
		)
			throw new DefinitionChangeError(
				'DEFINITION_TYPE_LOCKED',
				old.key,
				old.label,
				count(keyUsage)
			)
		if (
			keyUsage.products + keyUsage.variants > 0 &&
			(old.unit ?? null) !== (replacement.unit ?? null)
		)
			throw new DefinitionChangeError(
				'DEFINITION_UNIT_LOCKED',
				old.key,
				old.label,
				count(keyUsage)
			)
		const kept = new Set(replacement.options.map(option => option.id))
		for (const option of old.options) {
			const optionUsage = keyUsage.options[option.id]
			if (!kept.has(option.id) && optionUsage && used(optionUsage))
				throw new DefinitionChangeError('OPTION_IN_USE', old.key, old.label, optionUsage, {
					id: option.id,
					label: option.label
				})
		}
		if (
			keyUsage.pins &&
			(old.filter_enabled !== replacement.filter_enabled ||
				old.filter_type !== replacement.filter_type)
		)
			throw new DefinitionChangeError('FILTER_PINNED', old.key, old.label, {
				products: 0,
				variants: 0,
				landings: keyUsage.pins
			})
		// A variation is built on a required characteristic only (owner, 2026-11-06): while SKUs
		// vary by it, it stays required.
		if (keyUsage.variants > 0 && old.is_required && !replacement.is_required)
			throw new DefinitionChangeError('AXIS_REQUIRED', old.key, old.label, count(keyUsage))
		if (options.published && replacement.is_required && !old.is_required && keyUsage.missing)
			throw new DefinitionChangeError('REQUIRED_VALUES_MISSING', old.key, replacement.label, {
				products: keyUsage.missing,
				variants: 0,
				landings: 0
			})
	}
	const known = new Set(before.map(definition => definition.key))
	for (const definition of next)
		if (
			!known.has(definition.key) &&
			definition.is_required &&
			options.published &&
			usage.products
		)
			throw new DefinitionChangeError(
				'REQUIRED_VALUES_MISSING',
				definition.key,
				definition.label,
				{ products: usage.products, variants: 0, landings: 0 }
			)
}

/**
 * Last line of defence after `checkDefinitionChange`: nothing that was valid under the old
 * definitions may become invalid under the new ones. Pre-existing invalid rows (an old import)
 * do not block unrelated edits; they are compared, not judged afresh.
 */
export function assertDataStaysValid(
	before: AttributeDefinition[],
	next: AttributeDefinition[],
	data: CategoryData,
	options: { published: boolean }
) {
	const ok = (check: () => unknown) => {
		try {
			check()
			return true
		} catch {
			return false
		}
	}
	const broken = { products: 0, variants: 0, landings: 0 }
	const axisOf = new Map<string, string | undefined>()
	for (const product of data.products) {
		const axisKey = axisKeyOf(product.variant_axis)
		axisOf.set(product.id, axisKey)
		const valid = (definitions: AttributeDefinition[]) =>
			ok(() =>
				validateAttributes(definitions, product.attributes_v2, {
					active: options.published,
					axisKey
				})
			)
		if (valid(before) && !valid(next)) broken.products++
	}
	for (const variant of data.variants) {
		const axisKey = axisOf.get(variant.product_id)
		if (!axisKey) continue
		const valid = (definitions: AttributeDefinition[]) =>
			ok(() => validateVariantValue(definitions, axisKey, variant.variant_value))
		if (valid(before) && !valid(next)) broken.variants++
	}
	for (const landing of data.landings) {
		const pins = pinsOf(landing.filters_v2)
		const valid = (definitions: AttributeDefinition[]) =>
			ok(() => {
				parseAttributeFilters(definitions, {
					attributes: (landing.filters_v2 as { attributes?: unknown })?.attributes ?? []
				})
				if (
					pins.color_families.length &&
					!definitions.some(definition => definition.semantic === 'color')
				)
					throw Error('COLOUR_AXIS_REQUIRED')
			})
		if (valid(before) && !valid(next)) broken.landings++
	}
	if (broken.products + broken.variants + broken.landings)
		throw new DefinitionChangeError('DEFINITION_CHANGE_INVALIDATES_DATA', null, null, broken)
}
