import type { AttributeDefinition } from '../category/attribute-definitions'
import { planTransfer } from './typed-product-transfer'

const definition = (
	key: string,
	label: string,
	extra: Partial<AttributeDefinition> = {}
): AttributeDefinition => ({
	key,
	label,
	value_type: 'string',
	unit: null,
	is_required: false,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: [],
	...extra
})
const single = [{ id: 'a', variant_value: null }]

describe('planTransfer', () => {
	it('never converts across units or types, and keeps one value of a single-valued target', () => {
		const plan = planTransfer(
			{
				definitions: [
					definition('weight', 'Вага', { value_type: 'number', unit: 'кг' }),
					definition('flag', 'Ознака', { value_type: 'boolean' }),
					definition('tags', 'Мітки', { multiple: true }),
					definition('note', 'Примітка')
				],
				attributes_v2: [
					{ k: 'weight', v: 1 },
					{ k: 'flag', v: true },
					{ k: 'tags', v: 'a' },
					{ k: 'tags', v: 'b' },
					{ k: 'note', v: 'x' }
				],
				variants: single
			},
			[
				definition('weight', 'Вага', { value_type: 'number', unit: 'г' }),
				definition('flag', 'Ознака'),
				definition('tags', 'Мітки'),
				definition('colour', 'Примітка', { semantic: 'color' })
			]
		)
		expect(plan.attributes_v2).toEqual([{ k: 'tags', v: 'a' }])
		expect(plan.dropped.map(row => `${row.key}:${row.reason}`)).toEqual([
			'weight:type',
			'flag:type',
			'tags:multiple',
			// A free text never lands in a dictionary-colour definition, even with the same label.
			'note:no_target'
		])
	})

	it('maps a numeric axis value by key and refuses values that collide or do not convert', () => {
		const source = {
			definitions: [definition('size', 'Розмір', { value_type: 'number', unit: 'см' })],
			attributes_v2: [],
			axisKey: 'size',
			variants: [
				{ id: 'a', variant_value: 140 },
				{ id: 'b', variant_value: 160 }
			]
		}
		expect(
			planTransfer(source, [
				definition('size', 'Розмір', { value_type: 'number', unit: 'см' })
			])
		).toMatchObject({ axis_problem: null, variant_axis: { key: 'size' } })
		expect(
			planTransfer(source, [
				definition('size', 'Розмір', { value_type: 'number', unit: 'мм' })
			]).axis_problem
		).toBe('AXIS_VALUES')
		expect(
			planTransfer(source, [definition('size', 'Розмір', { multiple: true })]).axis_problem
		).toBe('AXIS_NO_TARGET')
		expect(
			planTransfer(source, [definition('size', 'Розмір', { semantic: 'color' })]).axis_problem
		).toBe('AXIS_TYPE')
	})

	it('drops a characteristic that would land on the target axis and lists missing required values', () => {
		const plan = planTransfer(
			{
				definitions: [
					definition('colour_text', 'Колір'),
					definition('axis', 'Колір', { semantic: 'color' })
				],
				attributes_v2: [{ k: 'colour_text', v: 'Веселка' }],
				axisKey: 'axis',
				variants: [{ id: 'a', variant_value: 'id-1' }]
			},
			[
				definition('axis', 'Колір', { semantic: 'color' }),
				definition('colour_text', 'Колір'),
				definition('brand', 'Виробник', { is_required: true })
			]
		)
		expect(plan.attributes_v2).toEqual([{ k: 'colour_text', v: 'Веселка' }])
		expect(plan.missing_required).toEqual(['brand'])
		expect(plan.variants).toEqual([{ id: 'a', variant_value: 'id-1' }])
	})

	it('finds the colour axis among two definitions sharing the label «Колір» in a copied category', () => {
		const filament = [
			definition('kolir', 'Колір'),
			definition('color', 'Колір', { semantic: 'color' })
		]
		const copy = [
			definition('kolir_2', 'Колір'),
			definition('color_2', 'Колір', { semantic: 'color' })
		]
		expect(
			planTransfer(
				{
					definitions: filament,
					attributes_v2: [],
					axisKey: 'color',
					variants: [{ id: 'a', variant_value: 'id-1' }]
				},
				copy
			)
		).toMatchObject({ axis_problem: null, variant_axis: { key: 'color_2' } })
		expect(
			planTransfer(
				{
					definitions: filament,
					attributes_v2: [{ k: 'kolir', v: 'Веселка' }],
					variants: single
				},
				copy
			).attributes_v2
		).toEqual([{ k: 'kolir_2', v: 'Веселка' }])
	})
})
