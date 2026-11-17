import {
	AttributeContractError,
	AttributeDefinition,
	isAxisCandidate,
	parseDefinitions,
	validateAttributes,
	validateScalarValue,
	validateVariantValue
} from './attribute-definitions'
const definition = (patch: Partial<AttributeDefinition> = {}): AttributeDefinition => ({
	key: 'rated_current',
	label: 'Номінальний струм',
	value_type: 'number',
	unit: 'А',
	is_required: true,
	filter_enabled: true,
	filter_type: 'range',
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: [],
	...patch
})
function expectCode(action: () => unknown, code: AttributeContractError['code']) {
	try {
		action()
		throw new Error('Expected failure')
	} catch (error) {
		expect(error).toBeInstanceOf(AttributeContractError)
		expect((error as AttributeContractError).code).toBe(code)
	}
}
it.each([
	{ filter_enabled: false },
	{ value_type: 'string' },
	{ multiple: true },
	{ value_type: 'boolean', filter_type: 'multi-select' },
	{ value_type: 'enum', filter_type: 'multi-select' },
	{ options: [{ id: 'x', label: 'X', order: 0 }] },
	{ order: -1 },
	{ label: '  ' }
] as Partial<AttributeDefinition>[])('rejects inconsistent definition %j', patch => {
	expectCode(() => parseDefinitions([definition(patch)]), 'INVALID_DEFINITION')
})
it('rejects duplicate keys and enum IDs', () => {
	expectCode(() => parseDefinitions([definition(), definition()]), 'DUPLICATE_KEY')
	const option = { id: 'small', label: 'Малий', order: 0 }
	expectCode(
		() =>
			parseDefinitions([
				definition({
					value_type: 'enum',
					filter_type: 'multi-select',
					options: [option, option]
				})
			]),
		'INVALID_DEFINITION'
	)
})
it('marks one text or list characteristic as the brand (owner, 2026-11-05)', () => {
	const brand = (key: string, patch: Partial<AttributeDefinition> = {}) =>
		definition({
			key,
			label: 'Виробник',
			value_type: 'string',
			unit: null,
			filter_enabled: false,
			filter_type: null,
			semantic: 'brand',
			...patch
		})
	expect(parseDefinitions([brand('maker')])).toHaveLength(1)
	// Two would make the page, the feed and the exports disagree.
	expectCode(() => parseDefinitions([brand('maker'), brand('other')]), 'INVALID_DEFINITION')
	expectCode(() => parseDefinitions([definition({ semantic: 'brand' })]), 'INVALID_DEFINITION')
})
it('preserves false and zero without string coercion', () => {
	const defs = [
		definition(),
		definition({
			key: 'washable',
			value_type: 'boolean',
			unit: null,
			filter_type: 'multi-select'
		})
	]
	const values = [
		{ k: 'rated_current', v: 0 },
		{ k: 'washable', v: false }
	]
	expect(validateAttributes(defs, values, { active: true })).toEqual(values)
	for (const v of ['16', null, [], {}, NaN, Infinity])
		expectCode(() => validateAttributes(defs, [{ k: 'rated_current', v }]), 'INVALID_VALUE')
})
it('requires active values while drafts still reject unknown keys', () => {
	expect(validateAttributes([definition()], [])).toEqual([])
	expectCode(() => validateAttributes([definition()], [], { active: true }), 'REQUIRED_VALUE')
	expectCode(() => validateAttributes([definition()], [{ k: 'typo', v: 16 }]), 'UNKNOWN_KEY')
})
it('keeps commas and deduplicates multivalue without mutating input', () => {
	const defs = [definition({ value_type: 'string', filter_type: 'multi-select', multiple: true })]
	const input = [
		{ k: 'rated_current', v: 'Чорний, білий' },
		{ k: 'rated_current', v: 'Чорний, білий' },
		{ k: 'rated_current', v: 'Сірий' }
	]
	const result = validateAttributes(defs, input)
	expect(result.map(e => e.v)).toEqual(['Чорний, білий', 'Сірий'])
	expect(input).toHaveLength(3)
	result[0].v = 'Changed'
	expect(input[0].v).toBe('Чорний, білий')
	expectCode(() => validateAttributes(defs, [{ k: 'rated_current', v: '  ' }]), 'INVALID_VALUE')
})
it('rejects repeated single values', () => {
	expectCode(
		() =>
			validateAttributes(
				[definition()],
				[
					{ k: 'rated_current', v: 16 },
					{ k: 'rated_current', v: 16 }
				]
			),
		'MULTIPLE_VALUES'
	)
})
it('uses enum IDs, not labels', () => {
	const before = definition({
		value_type: 'enum',
		filter_type: 'multi-select',
		options: [
			{ id: 'small', label: 'Малий', order: 0 },
			{ id: 'large', label: 'Великий', order: 1 }
		]
	})
	expect(validateAttributes([before], [{ k: before.key, v: 'small' }])).toHaveLength(1)
	expectCode(() => validateAttributes([before], [{ k: before.key, v: 'Малий' }]), 'INVALID_VALUE')
})
it('validates the axis separately without inferring a color', () => {
	const size = definition({
		key: 'size',
		value_type: 'enum',
		semantic: 'size',
		unit: null,
		is_required: true,
		filter_type: 'multi-select',
		options: [{ id: '150x180', label: '150 × 180 см', order: 0 }]
	})
	expect(validateAttributes([size], [], { active: true, axisKey: 'size' })).toEqual([])
	expect(validateVariantValue([size], 'size', '150x180')).toBe('150x180')
	expectCode(() => validateVariantValue([size], 'size', null), 'INVALID_VALUE')
	expectCode(() => validateVariantValue([size], 'color', 'blue'), 'INVALID_AXIS')
	expectCode(
		() => validateVariantValue([{ ...size, multiple: true }], 'size', 'L'),
		'INVALID_AXIS'
	)
	expectCode(
		() =>
			validateAttributes([size], [{ k: 'size', v: 'L' }], { active: true, axisKey: 'size' }),
		'INVALID_AXIS'
	)
})
it('builds a variation only on a required list, number, yes/no or colour (owner, 2026-11-06)', () => {
	const axis = (extra: Partial<AttributeDefinition>) =>
		definition({ key: 'axis', is_required: true, filter_type: 'multi-select', ...extra })
	for (const ok of [
		axis({ value_type: 'number', unit: 'А' }),
		axis({ value_type: 'boolean' }),
		axis({ value_type: 'enum', options: [{ id: 'a', label: 'A', order: 0 }] }),
		axis({
			value_type: 'string',
			unit: null,
			semantic: 'color',
			filter_enabled: false,
			filter_type: null
		})
	])
		expect(isAxisCandidate(ok)).toBe(true)
	// Free text («63A» and «63 А» would be two variants) and an optional characteristic are refused.
	expect(isAxisCandidate(axis({ value_type: 'string' }))).toBe(false)
	expect(isAxisCandidate(axis({ value_type: 'number', is_required: false }))).toBe(false)
	expectCode(
		() => validateVariantValue([axis({ value_type: 'string' })], 'axis', '63A'),
		'INVALID_AXIS'
	)
	// A filter operand is not a variation: any characteristic may filter.
	expect(validateScalarValue(axis({ value_type: 'string', is_required: false }), 'x')).toBe('x')
})
it('keeps the colour on the SKU: one dictionary colour, never product text, never a filter', () => {
	const colour = definition({
		key: 'color',
		value_type: 'string',
		unit: null,
		semantic: 'color',
		is_required: true,
		filter_enabled: false,
		filter_type: null
	})
	expectCode(
		() => validateAttributes([colour], [{ k: 'color', v: 'Чорний' }]),
		'COLOR_VALUE_ON_SKU'
	)
	expectCode(
		() => parseDefinitions([{ ...colour, filter_enabled: true, filter_type: 'multi-select' }]),
		'INVALID_DEFINITION'
	)
	expectCode(() => parseDefinitions([{ ...colour, value_type: 'enum' }]), 'INVALID_DEFINITION')
	expectCode(() => parseDefinitions([colour, { ...colour, key: 'color2' }]), 'INVALID_DEFINITION')
})

it('never silently normalizes persisted keys or enum IDs', () => {
	expectCode(
		() => parseDefinitions([definition({ key: ' rated_current' })]),
		'INVALID_DEFINITION'
	)
	expectCode(
		() => validateAttributes([definition()], [{ k: 'rated_current ', v: 16 }]),
		'INVALID_VALUE'
	)
	expectCode(
		() =>
			parseDefinitions([
				definition({
					value_type: 'enum',
					filter_type: 'multi-select',
					options: [{ id: ' small ', label: 'Small', order: 0 }]
				})
			]),
		'INVALID_DEFINITION'
	)
})
