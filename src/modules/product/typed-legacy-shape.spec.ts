import type { AttributeDefinition } from '../category/attribute-definitions'
import { legacyShapeOf, withAxisColourRow } from './typed-legacy-shape'

const definition = (
	key: string,
	extra: Partial<AttributeDefinition> = {}
): AttributeDefinition => ({
	key,
	label: key,
	value_type: 'string',
	unit: null,
	is_required: false,
	multiple: false,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	semantic: 'generic',
	options: [],
	...extra
})
const category = (definitions: AttributeDefinition[]) => ({
	attribute_contract_version: 2,
	attribute_definitions: definitions
})

describe('legacyShapeOf', () => {
	it('reproduces the migrated filament rows: stored order, text numbers, kolir colour axis', () => {
		const shape = legacyShapeOf(
			category([
				definition('vaha', { label: 'Вага філаменту', value_type: 'number', unit: 'кг' }),
				definition('material', { label: 'Матеріал', visible_in_specs: false }),
				definition('vyrobnyk', {
					label: 'Виробник',
					semantic: 'brand',
					visible_in_specs: false
				}),
				definition('color', { label: 'Колір', semantic: 'color' })
			]),
			{
				attributes_v2: [
					{ k: 'vyrobnyk', v: 'Kingroon' },
					{ k: 'material', v: 'PETG' },
					{ k: 'vaha', v: 0.5 }
				],
				variant_axis: { key: 'color' },
				variant_value: '6aa3b20c855809afd2191b2f',
				v_value: 'Black'
			}
		)
		// Hidden from the page's table is still exported: the exports never hid «Матеріал» or
		// «Виробник» (one visibility switch, owner 2026-11-05).
		expect(shape).toEqual({
			attributes: [
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
				{ k: 'material', l: 'Матеріал', v: 'PETG' },
				{ k: 'vaha', l: 'Вага філаменту', v: '0.5' }
			],
			variant: { key: 'kolir', label: 'Колір', value: 'Black' },
			manufacturer: 'Kingroon'
		})
	})

	it('formats enum, boolean and a non-colour axis, and puts a brand entity first', () => {
		const shape = legacyShapeOf(
			category([
				definition('poles', {
					label: 'Полюси',
					value_type: 'enum',
					options: [{ id: 'four', label: 'Чотири', order: 0 }]
				}),
				definition('automatic', { label: 'Автомат', value_type: 'boolean' }),
				definition('maker', { label: 'Виробник', semantic: 'brand' }),
				definition('current', { label: 'Струм', value_type: 'number', unit: 'А' })
			]),
			{
				attributes_v2: [
					{ k: 'poles', v: 'four' },
					{ k: 'automatic', v: true },
					{ k: 'maker', v: 'Other' },
					{ k: 'removed', v: 'x' },
					{ k: 'poles', v: 'gone-option' }
				],
				variant_axis: { key: 'current' },
				variant_value: 63,
				brand_name: 'Bemko'
			}
		)
		expect(shape).toEqual({
			attributes: [
				{ k: 'brand', l: 'Виробник', v: 'Bemko' },
				{ k: 'poles', l: 'Полюси', v: 'Чотири' },
				{ k: 'automatic', l: 'Автомат', v: 'Так' },
				{ k: 'maker', l: 'Виробник', v: 'Other' }
			],
			variant: { key: 'current', label: 'Струм', value: '63 А' },
			// The brand entity wins over the characteristic marked `brand`.
			manufacturer: 'Bemko'
		})
	})

	it('has no variant without an axis or without a colour name', () => {
		const definitions = [definition('color', { label: 'Колір', semantic: 'color' })]
		expect(legacyShapeOf(category(definitions), { variant_axis: null }).variant).toBeNull()
		expect(
			legacyShapeOf(category(definitions), { variant_axis: { key: 'color' }, v_value: null })
				.variant
		).toBeNull()
	})

	describe('withAxisColourRow (partner cards)', () => {
		const filament = category([
			definition('material', { label: 'Матеріал' }),
			definition('kolir', { label: 'Колір' }),
			definition('color', { label: 'Колір', semantic: 'color' })
		])
		const rows = [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
			{ k: 'material', l: 'Матеріал', v: 'PETG' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PETG' }
		]

		it("puts the SKU's own colour where the legacy image had the stale copy", () => {
			expect(
				withAxisColourRow(rows, filament, {
					variant_axis: { key: 'color' },
					colour_name: 'Білий',
					legacy_attributes: [
						{ k: 'vyrobnyk' },
						{ k: 'material' },
						{ k: 'kolir' },
						{ k: 'polymer' }
					]
				}).map(row => `${row.k}=${row.v}`)
			).toEqual(['vyrobnyk=Kingroon', 'material=PETG', 'kolir=Білий', 'polymer=PETG'])
		})

		it('keeps that place when the row before it was not carried over (owner, 2026-11-06)', () => {
			// «Матеріал» stood before the colour in the legacy card; the migration drops it.
			expect(
				withAxisColourRow(
					rows.filter(row => row.k !== 'material'),
					filament,
					{
						variant_axis: { key: 'color' },
						colour_name: 'Білий',
						legacy_attributes: [
							{ k: 'vyrobnyk' },
							{ k: 'material' },
							{ k: 'kolir' },
							{ k: 'polymer' }
						]
					}
				).map(row => `${row.k}=${row.v}`)
			).toEqual(['vyrobnyk=Kingroon', 'kolir=Білий', 'polymer=PETG'])
		})

		it('appends it without a legacy image and replaces any stored row of that key', () => {
			expect(
				withAxisColourRow([...rows, { k: 'kolir', l: 'Колір', v: 'Чорний' }], filament, {
					variant_axis: { key: 'color' },
					colour_name: 'Білий'
				}).map(row => `${row.k}=${row.v}`)
			).toEqual(['vyrobnyk=Kingroon', 'material=PETG', 'polymer=PETG', 'kolir=Білий'])
		})

		it('keeps a leading brand entity first when the legacy row was first', () => {
			expect(
				withAxisColourRow([{ k: 'brand', l: 'Виробник', v: 'Bemko' }, ...rows], filament, {
					variant_axis: { key: 'color' },
					colour_name: 'Білий',
					legacy_attributes: [{ k: 'kolir' }, { k: 'material' }]
				}).map(row => row.k)
			).toEqual(['brand', 'kolir', 'vyrobnyk', 'material', 'polymer'])
		})

		it('changes nothing without a colour axis or a dictionary colour', () => {
			const avr = category([definition('current', { value_type: 'number' })])
			expect(
				withAxisColourRow(rows, avr, {
					variant_axis: { key: 'current' },
					colour_name: 'Білий'
				})
			).toBe(rows)
			expect(
				withAxisColourRow(rows, filament, {
					variant_axis: { key: 'color' },
					colour_name: null
				})
			).toBe(rows)
			expect(
				withAxisColourRow(rows, filament, { variant_axis: null, colour_name: 'Білий' })
			).toBe(rows)
		})
	})
})
