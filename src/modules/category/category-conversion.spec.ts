import { remapPins } from './category-conversion'
import type { AttributeDefinition } from './attribute-definitions'

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
	filter_enabled: true,
	filter_type: 'multi-select',
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: [],
	...extra
})
const pins = (attributes: unknown[], color_families: string[] = []) => ({
	attributes,
	category_ids: [],
	brand_ids: [],
	color_families
})

describe('remapPins (landing pins in the target category of a conversion)', () => {
	const source = [
		definition('polymer', 'Тип пластику'),
		definition('series', 'Серія', {
			value_type: 'enum',
			options: [{ id: 'basic', label: 'Basic', order: 0 }]
		}),
		definition('weight', 'Вага', { value_type: 'number', unit: 'кг', filter_type: 'range' }),
		definition('color', 'Колір', {
			semantic: 'color',
			filter_enabled: false,
			filter_type: null
		})
	]
	it('carries pins into a copied category by label, enum options by their label', () => {
		const target = [
			definition('polymer_2', 'Тип пластику'),
			definition('series_2', 'серія', {
				value_type: 'enum',
				options: [{ id: 'opt-1', label: 'basic', order: 0 }]
			}),
			definition('weight_2', 'Вага', {
				value_type: 'number',
				unit: 'кг',
				filter_type: 'range'
			}),
			definition('color_2', 'Колір', {
				semantic: 'color',
				filter_enabled: false,
				filter_type: null
			})
		]
		expect(
			remapPins(
				source,
				target,
				pins(
					[
						{ key: 'polymer', values: ['PLA'] },
						{ key: 'series', values: ['basic'] },
						{ key: 'weight', min: 1 }
					],
					['black']
				)
			)
		).toEqual(
			pins(
				[
					{ key: 'polymer_2', values: ['PLA'] },
					{ key: 'series_2', values: ['opt-1'] },
					{ key: 'weight_2', min: 1 }
				],
				['black']
			)
		)
	})
	it('refuses what it would have to guess: another unit, a missing key, colour without an axis', () => {
		const grams = [
			definition('polymer', 'Тип пластику'),
			definition('weight', 'Вага', { value_type: 'number', unit: 'г', filter_type: 'range' })
		]
		expect(remapPins(source, grams, pins([{ key: 'weight', max: 2 }]))).toBeNull()
		expect(remapPins(source, grams, pins([{ key: 'series', values: ['basic'] }]))).toBeNull()
		expect(
			remapPins(source, grams, pins([{ key: 'polymer', values: ['PLA'] }], ['black']))
		).toBeNull()
		expect(remapPins(source, grams, pins([{ key: 'polymer', values: ['PLA'] }]))).toEqual(
			pins([{ key: 'polymer', values: ['PLA'] }])
		)
	})
})
