import { z } from 'zod'
import { generateAttrKey } from 'src/common/utils/attribute.utils'

const nonempty = z.string().trim().min(1)
// IDs are opaque: reject whitespace instead of silently changing persisted identity.
const identifier = z
	.string()
	.min(1)
	.refine(value => value === value.trim())
const optionSchema = z.strictObject({
	id: identifier,
	label: nonempty,
	order: z.number().int().nonnegative()
})

/** Internal v2 contract. Not accepted by legacy category/product HTTP writes. */
export const attributeDefinitionSchema = z
	.strictObject({
		key: identifier,
		label: nonempty,
		value_type: z.enum(['string', 'number', 'boolean', 'enum']),
		unit: nonempty.nullable(),
		is_required: z.boolean(),
		filter_enabled: z.boolean(),
		filter_type: z.enum(['multi-select', 'range']).nullable(),
		visible_in_specs: z.boolean(),
		order: z.number().int().nonnegative(),
		multiple: z.boolean(),
		/**
		 * What the characteristic means to the shop beyond its label: `brand` is where a product
		 * without a brand entity takes its brand (page, feed, exports) — never a «Виробник» label
		 * match (owner, 2026-11-05).
		 */
		semantic: z.enum(['generic', 'color', 'size', 'material', 'brand']),
		options: z.array(optionSchema)
	})
	.superRefine((definition, ctx) => {
		const invalid = (field: string, message: string) =>
			ctx.addIssue({ code: 'custom', path: [field], message })
		if (definition.filter_enabled !== (definition.filter_type !== null)) {
			invalid('filter_type', 'Enabled filters require a type; disabled filters require null')
		}
		if (
			definition.filter_type === 'range' &&
			(definition.value_type !== 'number' || definition.multiple)
		) {
			invalid('filter_type', 'Ranges require a single numeric value')
		}
		if (definition.value_type === 'boolean' && definition.unit !== null) {
			invalid('unit', 'Boolean values cannot have a unit')
		}
		if (definition.value_type !== 'enum' && definition.options.length) {
			invalid('options', 'Only enums have options')
		}
		if (definition.value_type === 'enum' && !definition.options.length) {
			invalid('options', 'Enums require at least one option')
		}
		if (
			new Set(definition.options.map(option => option.id)).size !== definition.options.length
		) {
			invalid('options', 'Option IDs must be unique')
		}
		if (
			definition.semantic === 'brand' &&
			!['string', 'enum'].includes(definition.value_type)
		) {
			invalid('semantic', 'A brand is text or a list option')
		}
		// The colour is the SKU's dictionary colour (stored by id), filtered by its family — never a
		// list of its own, several values or an attribute filter (owner, 2026-11-06).
		if (definition.semantic === 'color') {
			if (
				definition.value_type !== 'string' ||
				definition.multiple ||
				definition.unit !== null
			)
				invalid('semantic', 'A colour is one dictionary colour per SKU')
			if (definition.filter_enabled)
				invalid('filter_enabled', 'A colour is filtered by its dictionary family')
		}
	})

export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>

/**
 * What a new product category starts with (owner, 2026-11-08): the brand, required — without it
 * none of its products enters Google Merchant (`missing_brand`). An ordinary characteristic from
 * then on: the admin may rename it, change it or remove it.
 */
export function defaultProductDefinitions(): AttributeDefinition[] {
	return [
		{
			key: generateAttrKey('Виробник'),
			label: 'Виробник',
			value_type: 'string',
			unit: null,
			is_required: true,
			filter_enabled: true,
			filter_type: 'multi-select',
			visible_in_specs: true,
			order: 0,
			multiple: false,
			semantic: 'brand',
			options: []
		}
	]
}
export type AttributeValue = string | number | boolean
export interface AttributeEntry {
	k: string
	v: AttributeValue
}

export class AttributeContractError extends Error {
	constructor(
		readonly code:
			| 'INVALID_DEFINITION'
			| 'DUPLICATE_KEY'
			| 'INVALID_VALUE'
			| 'UNKNOWN_KEY'
			| 'MULTIPLE_VALUES'
			| 'REQUIRED_VALUE'
			| 'INVALID_AXIS'
			| 'COLOR_VALUE_ON_SKU',
		readonly field: string
	) {
		super(`${code}: ${field}`)
		this.name = 'AttributeContractError'
	}
}

export function parseDefinitions(input: unknown): AttributeDefinition[] {
	const parsed = z.array(attributeDefinitionSchema).safeParse(input)
	if (!parsed.success) {
		throw new AttributeContractError(
			'INVALID_DEFINITION',
			parsed.error.issues[0].path.join('.')
		)
	}
	const keys = new Set<string>()
	for (const definition of parsed.data) {
		if (keys.has(definition.key))
			throw new AttributeContractError('DUPLICATE_KEY', definition.key)
		keys.add(definition.key)
	}
	// One place for the brand: two would make the page, the feed and the exports disagree. One
	// colour for the same reason: the swatches, the colour filter and `g:color` read it.
	for (const semantic of ['brand', 'color'] as const)
		if (parsed.data.filter(definition => definition.semantic === semantic).length > 1)
			throw new AttributeContractError('INVALID_DEFINITION', 'semantic')
	return parsed.data
}

/**
 * Whether a characteristic can carry a product's variation (owner, 2026-11-06, as Magento's
 * configurable attributes and Akeneo's variant axes): required — every product of the category
 * has it — with one value from a closed set: a list, a number with its unit, yes/no, or the
 * colour dictionary. Free text would make «63A» and «63 А» two variants.
 */
export function isAxisCandidate(definition: AttributeDefinition): boolean {
	return (
		definition.is_required &&
		!definition.multiple &&
		(['enum', 'number', 'boolean'].includes(definition.value_type) ||
			definition.semantic === 'color')
	)
}

const entrySchema = z.strictObject({
	k: identifier,
	v: z.union([z.string().min(1), z.number(), z.boolean()])
})

function matchesValue(definition: AttributeDefinition, value: AttributeValue): boolean {
	switch (definition.value_type) {
		case 'string':
			return typeof value === 'string' && value.trim().length > 0
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
		case 'boolean':
			return typeof value === 'boolean'
		case 'enum':
			return (
				typeof value === 'string' && definition.options.some(option => option.id === value)
			)
	}
}

/**
 * One scalar against its definition — a catalogue filter operand or a landing pin. Says nothing
 * about the variation rules: a filter may use any characteristic, a variation only some.
 */
export function validateScalarValue(
	definition: AttributeDefinition,
	value: unknown
): AttributeValue {
	const parsed = entrySchema.safeParse({ k: definition.key, v: value })
	if (!parsed.success || !matchesValue(definition, parsed.data.v)) {
		throw new AttributeContractError('INVALID_VALUE', definition.key)
	}
	return parsed.data.v
}

/** A SKU's value of its product's variation: the axis must qualify (`isAxisCandidate`). */
export function validateVariantValue(
	definitions: readonly AttributeDefinition[],
	axisKey: string,
	value: unknown
): AttributeValue {
	const axis = parseDefinitions(definitions).find(definition => definition.key === axisKey)
	if (!axis || !isAxisCandidate(axis)) throw new AttributeContractError('INVALID_AXIS', axisKey)
	return validateScalarValue(axis, value)
}

/** Full-array validation, no coercion and no inference from labels or variant text. */
export function validateAttributes(
	definitions: readonly AttributeDefinition[],
	input: unknown,
	options: { active: boolean; axisKey?: string } = { active: false }
): AttributeEntry[] {
	const checked = parseDefinitions(definitions)
	const byKey = new Map(checked.map(definition => [definition.key, definition]))
	if (options.axisKey !== undefined) {
		const axis = byKey.get(options.axisKey)
		if (!axis || !isAxisCandidate(axis))
			throw new AttributeContractError('INVALID_AXIS', options.axisKey)
	}
	const parsed = z.array(entrySchema).safeParse(input)
	if (!parsed.success) {
		throw new AttributeContractError('INVALID_VALUE', parsed.error.issues[0].path.join('.'))
	}
	const seen = new Map<string, Set<AttributeValue>>()
	const result: AttributeEntry[] = []
	for (const [index, entry] of parsed.data.entries()) {
		const definition = byKey.get(entry.k)
		if (!definition) throw new AttributeContractError('UNKNOWN_KEY', `${index}.k`)
		// A colour is chosen per SKU from the dictionary — the axis — never typed into the product:
		// such text reaches neither the colour filter nor Google (owner, 2026-11-06).
		if (definition.semantic === 'color')
			throw new AttributeContractError('COLOR_VALUE_ON_SKU', `${index}.k`)
		if (entry.k === options.axisKey)
			throw new AttributeContractError('INVALID_AXIS', `${index}.k`)
		if (!matchesValue(definition, entry.v)) {
			throw new AttributeContractError('INVALID_VALUE', `${index}.v`)
		}
		const values = seen.get(entry.k) ?? new Set<AttributeValue>()
		if (values.size && !definition.multiple) {
			throw new AttributeContractError('MULTIPLE_VALUES', `${index}.k`)
		}
		if (!values.has(entry.v)) result.push({ ...entry })
		values.add(entry.v)
		seen.set(entry.k, values)
	}
	if (options.active) {
		for (const definition of checked) {
			if (
				definition.is_required &&
				definition.key !== options.axisKey &&
				!seen.has(definition.key)
			) {
				throw new AttributeContractError('REQUIRED_VALUE', definition.key)
			}
		}
	}
	return result
}
