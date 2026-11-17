import { priceColumnsOf, priceValuesOf } from './price-columns'

const definition = (key: string, label: string, extra: object = {}) => ({
	key,
	label,
	value_type: 'string' as const,
	unit: null,
	is_required: false,
	filter_enabled: true,
	filter_type: 'multi-select' as const,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic' as const,
	options: [],
	...extra
})
const category = {
	attribute_contract_version: 2,
	attribute_definitions: [
		definition('color', 'Колір', {
			order: 4,
			filter_enabled: false,
			filter_type: null,
			semantic: 'color'
		}),
		definition('finish', 'Ефект поверхні', {
			order: 1,
			value_type: 'enum',
			multiple: true,
			options: [
				{ id: 'Silk', label: 'Шовковий (Silk)', order: 0 },
				{ id: 'Matte', label: 'Матовий (Matte)', order: 1 }
			]
		}),
		definition('current', 'Номінальний струм', { order: 2, value_type: 'number', unit: 'А' }),
		definition('weight', 'Вага', { order: 3, value_type: 'number', unit: 'кг' }),
		definition('note', 'Примітка', { order: 0, filter_enabled: false, filter_type: null })
	]
}

describe('price list columns', () => {
	it('are the filters of the category and its colour, in its order', () => {
		expect(priceColumnsOf(category as never)).toEqual([
			{ key: 'finish', label: 'Ефект поверхні' },
			{ key: 'current', label: 'Номінальний струм' },
			{ key: 'weight', label: 'Вага' },
			{ key: 'color', label: 'Колір' }
		])
		// A v1 category has none until it is migrated.
		expect(
			priceColumnsOf({ attribute_contract_version: 1, attribute_definitions: [] })
		).toEqual([])
		expect(priceColumnsOf(undefined)).toEqual([])
	})

	it('print labels and units, several values joined, the colour from the dictionary', () => {
		expect(
			priceValuesOf(category as never, {
				attributes_v2: [
					{ k: 'finish', v: 'Silk' },
					{ k: 'finish', v: 'Matte' },
					{ k: 'weight', v: 1 },
					{ k: 'note', v: 'x' }
				],
				variant_axis: { key: 'color' },
				variant_value: 'a1b2',
				color_label: 'Чорний (Black)'
			})
		).toEqual({
			finish: 'Шовковий (Silk), Матовий (Matte)',
			weight: '1 кг',
			color: 'Чорний (Black)'
		})
		// Another axis: the SKU's own value, with the unit; a missing value is absent.
		expect(
			priceValuesOf(category as never, {
				attributes_v2: [],
				variant_axis: { key: 'current' },
				variant_value: 63
			})
		).toEqual({ current: '63 А' })
	})
})
