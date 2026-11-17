import type { FeedVariantRow } from 'src/database/mongoose/repositories/product-variant.repository'
import type { AttributeDefinition } from '../category/attribute-definitions'
import { adaptFeedRow, type FeedCategory } from './feed-typed-adapter'

/**
 * One brand rule for every surface (P04, owner decision 02.11.2026): a linked brand entity wins —
 * as on the product page and the price sheet — so `g:brand` equals the page's JSON-LD `brand`.
 * Without one the brand is the characteristic marked `brand`, never a «Виробник» label match
 * (owner, 2026-11-05).
 */
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
const category = (vyrobnyk: Partial<AttributeDefinition>): FeedCategory => ({
	_id: 'c1',
	name: 'Філамент',
	attribute_contract_version: 2,
	attribute_definitions: [
		definition('vyrobnyk', 'Виробник', { order: 0, ...vyrobnyk }),
		definition('polymer', 'Тип пластику', { order: 1 }),
		definition('vaha', 'Вага', { order: 2, value_type: 'number', unit: 'кг' })
	]
})
const row = (brand_name: string | null) =>
	({
		_id: 'v1',
		product_id: 'p1',
		variant_value: null,
		v_value: null,
		color: null,
		product: {
			_id: 'p1',
			name: 'PLA',
			attributes: [],
			attributes_v2: [
				{ k: 'vyrobnyk', v: 'Kingroon' },
				{ k: 'polymer', v: 'PLA' },
				{ k: 'vaha', v: 1 }
			],
			variant_axis: null,
			brand_name
		},
		category: { _id: 'c1', name: 'Філамент', required_attributes: [] }
	}) as unknown as FeedVariantRow
const marked = category({ semantic: 'brand' })

it('takes the brand entity over the characteristic marked brand, as the page does', () => {
	expect(adaptFeedRow(row('Bambu Lab'), marked).semantic?.brand).toBe('Bambu Lab')
})

it('takes the characteristic marked brand without a brand entity — even hidden from the table', () => {
	expect(adaptFeedRow(row(null), marked).semantic?.brand).toBe('Kingroon')
	const hidden = category({ semantic: 'brand', visible_in_specs: false })
	expect(adaptFeedRow(row(null), hidden).semantic?.brand).toBe('Kingroon')
})

it('never finds a brand by the «Виробник» label', () => {
	expect(adaptFeedRow(row(null), category({})).semantic?.brand).toBeNull()
})

it('merges a characteristic with several values into one highlight, as the table row', () => {
	const several: FeedCategory = {
		...marked,
		attribute_definitions: marked.attribute_definitions.map(item =>
			item.key === 'polymer' ? { ...item, multiple: true } : item
		)
	}
	const two = row(null)
	two.product!.attributes_v2!.push({ k: 'polymer', v: 'PETG' })
	expect(adaptFeedRow(two, several).highlights).toEqual(['Тип пластику: PLA, PETG', 'Вага: 1 кг'])
})

it('highlights what the page table shows, without the brand', () => {
	expect(adaptFeedRow(row(null), marked).highlights).toEqual(['Тип пластику: PLA', 'Вага: 1 кг'])
	// Hidden from the table — hidden from the highlights.
	const hiddenPolymer: FeedCategory = {
		...marked,
		attribute_definitions: marked.attribute_definitions.map(item =>
			item.key === 'polymer' ? { ...item, visible_in_specs: false } : item
		)
	}
	expect(adaptFeedRow(row(null), hiddenPolymer).highlights).toEqual(['Вага: 1 кг'])
})
