import { z } from 'zod'
import {
	AttributeDefinition,
	AttributeEntry,
	AttributeValue,
	validateScalarValue
} from './attribute-definitions'
const key = z.string().min(1).max(100)
/** One attribute pin or filter: discrete values, or a numeric range. */
export const attributeFilterSchema = z.union([
	z.strictObject({
		key,
		values: z.array(z.union([z.string().min(1), z.number(), z.boolean()])).max(100)
	}),
	z
		.strictObject({ key, min: z.number().optional(), max: z.number().optional() })
		.refine(
			value =>
				(value.min !== undefined || value.max !== undefined) &&
				(value.min === undefined || value.max === undefined || value.min <= value.max)
		)
])
const filtersSchema = z.strictObject({ attributes: z.array(attributeFilterSchema).max(50) })
export type AttributeFilter = z.infer<typeof attributeFilterSchema>
export class CategoryFilterError extends Error {
	constructor(readonly code: string) {
		super(code)
	}
}
export function parseAttributeFilters(
	definitions: AttributeDefinition[],
	input: unknown
): AttributeFilter[] {
	if (Buffer.byteLength(JSON.stringify(input) ?? '') > 16384)
		throw new CategoryFilterError('FILTER_LIMIT_EXCEEDED')
	const parsed = filtersSchema.safeParse(input)
	if (!parsed.success) throw new CategoryFilterError('INVALID_ATTRIBUTE_FILTER')
	const byKey = new Map(definitions.map(item => [item.key, item])),
		seen = new Set<string>()
	for (const filter of parsed.data.attributes) {
		const definition = byKey.get(filter.key)
		if (!definition?.filter_enabled || seen.has(filter.key))
			throw new CategoryFilterError('UNKNOWN_OR_DUPLICATE_FILTER')
		seen.add(filter.key)
		if ('values' in filter) {
			if (definition.filter_type !== 'multi-select')
				throw new CategoryFilterError('INVALID_FILTER_OPERATOR')
			for (const value of filter.values) {
				// Scalar validation only: multiplicity concerns the product field, and the variation
				// rules (`isAxisCandidate`) are not a filter's — any characteristic may filter.
				try {
					validateScalarValue(definition, value)
				} catch {
					throw new CategoryFilterError('INVALID_FILTER_VALUE')
				}
			}
		} else if (definition.filter_type !== 'range')
			throw new CategoryFilterError('INVALID_FILTER_OPERATOR')
	}
	return parsed.data.attributes.filter(filter => !('values' in filter) || filter.values.length)
}
export interface AttributeFilterRow {
	id: string
	product_id: string
	attributes: AttributeEntry[]
}
export interface AttributeFacet {
	key: string
	values: { value: AttributeValue; count: number }[]
	min: number | null
	max: number | null
}
/** OR within a dimension, AND between dimensions, and one SKU per match/count. */
export function attributeFilterResult(
	definitions: AttributeDefinition[],
	rows: AttributeFilterRow[],
	filters: AttributeFilter[]
) {
	const enabled = definitions
		.filter(definition => definition.filter_enabled)
		.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
	const counts = new Map(
		enabled.map(definition => [definition.key, new Map<AttributeValue, number>()])
	)
	const products = new Set<string>(),
		sample: string[] = []
	let total = 0
	for (const row of rows) {
		const attributes = new Map<string, Set<AttributeValue>>()
		for (const entry of row.attributes) {
			const values = attributes.get(entry.k) ?? new Set<AttributeValue>()
			values.add(entry.v)
			attributes.set(entry.k, values)
		}
		const failed = new Set<string>()
		for (const filter of filters) {
			const values = attributes.get(filter.key) ?? new Set<AttributeValue>()
			const matches =
				'values' in filter
					? filter.values.some(value => values.has(value))
					: [...values].some(
							value =>
								typeof value === 'number' &&
								(filter.min === undefined || value >= filter.min) &&
								(filter.max === undefined || value <= filter.max)
						)
			if (!matches) failed.add(filter.key)
			// Excluding one dimension cannot repair two failed dimensions.
			if (failed.size > 1) break
		}
		if (!failed.size) {
			total++
			products.add(row.product_id)
			if (sample.length < 50) sample.push(row.id)
		}
		if (failed.size > 1) continue
		for (const [key, values] of attributes) {
			const facet = counts.get(key)
			if (!facet || (failed.size && !failed.has(key))) continue
			for (const value of values) facet.set(value, (facet.get(value) ?? 0) + 1)
		}
	}
	const facets: AttributeFacet[] = enabled.map(definition => {
		const values = counts.get(definition.key)!
		const optionOrder = new Map(definition.options.map(option => [option.id, option.order]))
		const numeric = [...values.keys()].filter(
			(value): value is number => typeof value === 'number'
		)
		return {
			key: definition.key,
			values:
				definition.filter_type === 'range'
					? []
					: [...values]
							.map(([value, count]) => ({ value, count }))
							.sort((a, b) =>
								definition.value_type === 'enum'
									? (optionOrder.get(String(a.value)) ?? 0) -
											(optionOrder.get(String(b.value)) ?? 0) ||
										String(a.value).localeCompare(String(b.value))
									: typeof a.value === 'number' && typeof b.value === 'number'
										? a.value - b.value
										: String(a.value).localeCompare(String(b.value))
							),
			min: numeric.length
				? numeric.reduce((min, value) => Math.min(min, value), Infinity)
				: null,
			max: numeric.length
				? numeric.reduce((max, value) => Math.max(max, value), -Infinity)
				: null
		}
	})
	return {
		total_variants: total,
		total_products: products.size,
		sample_variant_ids: sample,
		facets
	}
}
