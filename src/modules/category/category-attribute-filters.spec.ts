import {
	attributeFilterResult,
	parseAttributeFilters,
	AttributeFilterRow
} from './category-attribute-filters'
import { AttributeDefinition } from './attribute-definitions'
const definition = (
	key: string,
	value_type: AttributeDefinition['value_type'],
	filter_type: AttributeDefinition['filter_type'] = 'multi-select'
): AttributeDefinition => ({
	key,
	label: key,
	value_type,
	filter_type,
	filter_enabled: true,
	is_required: false,
	unit: null,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: value_type === 'enum' ? [{ id: 'option-a', label: 'A', order: 0 }] : []
})
const defs = [
	definition('amps', 'number', 'range'),
	definition('heated', 'boolean'),
	definition('label', 'string'),
	definition('option', 'enum')
]
const rows: AttributeFilterRow[] = [
	{
		id: '1',
		product_id: 'p1',
		attributes: [
			{ k: 'amps', v: 16.5 },
			{ k: 'heated', v: false },
			{ k: 'label', v: 'Чорний, білий' }
		]
	},
	{
		id: '2',
		product_id: 'p1',
		attributes: [
			{ k: 'amps', v: 63 },
			{ k: 'heated', v: true },
			{ k: 'label', v: 'Інший' }
		]
	},
	{
		id: '3',
		product_id: 'p2',
		attributes: [
			{ k: 'amps', v: 32 },
			{ k: 'heated', v: false },
			{ k: 'label', v: 'Чорний, білий' },
			{ k: 'label', v: 'Чорний, білий' }
		]
	}
]
it('matches inclusive decimals, boolean false and comma-containing strings without coercion', () => {
	const filters = parseAttributeFilters(defs, {
		attributes: [
			{ key: 'amps', min: 16.5, max: 32 },
			{ key: 'heated', values: [false] },
			{ key: 'label', values: ['Чорний, білий'] }
		]
	})
	expect(attributeFilterResult(defs, rows, filters)).toMatchObject({
		total_variants: 2,
		total_products: 2,
		sample_variant_ids: ['1', '3']
	})
	expect(() =>
		parseAttributeFilters(defs, { attributes: [{ key: 'heated', values: ['false'] }] })
	).toThrow('INVALID_FILTER_VALUE')
})
it('excludes its own filter from facets, counts SKU once per value and ANDs the other dimensions', () => {
	const result = attributeFilterResult(
		defs,
		rows,
		parseAttributeFilters(defs, {
			attributes: [
				{ key: 'heated', values: [false] },
				{ key: 'amps', min: 20 }
			]
		})
	)
	expect(result.total_variants).toBe(1)
	expect(result.facets.find(value => value.key === 'amps')).toMatchObject({ min: 16.5, max: 32 })
	expect(result.facets.find(value => value.key === 'heated')?.values).toEqual([
		{ value: false, count: 1 },
		{ value: true, count: 1 }
	])
	expect(result.facets.find(value => value.key === 'label')?.values).toEqual([
		{ value: 'Чорний, білий', count: 1 }
	])
})
it('does not match a key and value from different attributes or different sibling SKU', () => {
	expect(
		attributeFilterResult(
			defs,
			rows,
			parseAttributeFilters(defs, {
				attributes: [
					{ key: 'amps', min: 60 },
					{ key: 'heated', values: [false] }
				]
			})
		).total_variants
	).toBe(0)
})
it('rejects invalid operators, duplicates, unknown/disabled keys, enum IDs and oversized input', () => {
	for (const attributes of [
		[{ key: 'amps', values: [16] }],
		[{ key: 'amps', min: 20, max: 10 }],
		[{ key: 'heated', min: 0 }],
		[{ key: 'heated', values: [true], min: 1 }],
		[
			{ key: 'amps', min: 0 },
			{ key: 'amps', max: 10 }
		],
		[{ key: 'absent', values: ['x'] }],
		[{ key: 'option', values: ['label-not-id'] }]
	])
		expect(() => parseAttributeFilters(defs, { attributes })).toThrow()
	expect(() =>
		parseAttributeFilters([{ ...defs[2], filter_enabled: false }], {
			attributes: [{ key: 'label', values: ['x'] }]
		})
	).toThrow()
	expect(() =>
		parseAttributeFilters(defs, { attributes: [{ key: 'label', values: ['x'.repeat(17000)] }] })
	).toThrow('FILTER_LIMIT_EXCEEDED')
})
it('normalizes empty selections and returns empty data without fabricating facet ranges', () => {
	const filters = parseAttributeFilters(defs, { attributes: [{ key: 'heated', values: [] }] })
	expect(filters).toEqual([])
	const result = attributeFilterResult(defs, [], filters)
	expect(result.total_variants).toBe(0)
	expect(
		result.facets.every(
			facet => facet.min === null && facet.max === null && !facet.values.length
		)
	).toBe(true)
})

it('orders enum facets by configured option order rather than opaque ID', () => {
	const option = {
		...defs[3],
		options: [
			{ id: 'z', label: 'First', order: 0 },
			{ id: 'a', label: 'Second', order: 1 }
		]
	}
	const result = attributeFilterResult(
		[option],
		[
			{ id: 'a', product_id: 'p', attributes: [{ k: 'option', v: 'a' }] },
			{ id: 'z', product_id: 'p', attributes: [{ k: 'option', v: 'z' }] }
		],
		[]
	)
	expect(result.facets[0].values.map(item => item.value)).toEqual(['z', 'a'])
})
