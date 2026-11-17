import { AttributeDefinition } from '../category/attribute-definitions'
import { validateTypedProduct } from './typed-product'
const def = (
	value_type: AttributeDefinition['value_type'],
	extra: Partial<AttributeDefinition> = {}
): AttributeDefinition => ({
	key: 'axis',
	label: 'Варіант',
	value_type,
	unit: null,
	is_required: true,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: [],
	...extra
})
const input = (variant_value: unknown) => ({
	name: 'Ковдра',
	attributes_v2: [],
	variant_axis: { key: 'axis' },
	variants: [{ id: '000000000000000000000001', variant_value }]
})
it('uses enum labels without exposing opaque IDs or inferring color', () => {
	const result = validateTypedProduct(
		[def('enum', { options: [{ id: 'opaque', label: 'Двоспальна', order: 0 }] })],
		input('opaque')
	)
	expect(result.variants[0]).toEqual({
		id: '000000000000000000000001',
		variant_value: 'opaque',
		name: 'Ковдра — Двоспальна'
	})
	expect(result.variants[0]).not.toHaveProperty('color_id')
})
it.each([
	[false, 'Ні'],
	[true, 'Так']
])('formats boolean %s without losing false', (value, label) => {
	expect(validateTypedProduct([def('boolean')], input(value)).variants[0].name).toBe(
		`Ковдра — ${label}`
	)
})
it('keeps decimal numbers, units and comma labels', () => {
	expect(validateTypedProduct([def('number', { unit: 'м' })], input(1.25)).variants[0].name).toBe(
		'Ковдра — 1.25 м'
	)
	expect(
		validateTypedProduct(
			[def('enum', { options: [{ id: 'small', label: 'Мала, тепла', order: 0 }] })],
			input('small')
		).variants[0].name
	).toBe('Ковдра — Мала, тепла')
})
it('builds a variation only on a required list, number, yes/no or colour (owner, 2026-11-06)', () => {
	// Free text would make «63A» and «63 А» two variants; an optional one leaves products without it.
	expect(() => validateTypedProduct([def('string')], input('Мала'))).toThrow('INVALID_AXIS')
	expect(() => validateTypedProduct([def('number', { is_required: false })], input(1))).toThrow(
		'INVALID_AXIS'
	)
})
it('requires exactly one null-valued SKU when no axis is used', () => {
	const plain = { ...input(null), variant_axis: null }
	expect(validateTypedProduct([], plain).variants[0].name).toBe('Ковдра')
	expect(() => validateTypedProduct([], { ...plain, variants: input('x').variants })).toThrow(
		'UNEXPECTED_VARIANT_VALUE'
	)
})
it('rejects multiple-valued axes and allows incomplete required attributes in a draft', () => {
	const list = def('enum', { options: [{ id: 'x', label: 'Ікс', order: 0 }] })
	expect(() => validateTypedProduct([{ ...list, multiple: true }], input('x'))).toThrow(
		'INVALID_AXIS'
	)
	expect(
		validateTypedProduct([list, def('number', { key: 'required_other' })], input('x'))
			.attributes_v2
	).toEqual([])
})
it('does not coerce numeric strings, null or objects', () => {
	for (const value of ['32', null, { value: 32 }, [32]])
		expect(() => validateTypedProduct([def('number')], input(value))).toThrow()
})
