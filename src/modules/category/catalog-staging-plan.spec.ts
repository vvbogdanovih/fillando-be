import { mongo } from 'mongoose'
import { buildCatalogStagingPlan, StagingCategory, StagingProduct } from './catalog-staging-plan'
const category: StagingCategory = {
	_id: new mongo.ObjectId(),
	required_attributes: [
		{ key: 'weight', label: 'Вага', is_required: true, unit: 'кг', filter_type: 'multi-select' }
	]
}
const product: StagingProduct = {
	_id: new mongo.ObjectId(),
	category_id: category._id,
	attributes: [
		{ k: 'weight', l: 'Вага', v: '1' },
		{ k: 'material', l: 'Матеріал', v: 'PLA' }
	]
}
it('stages product-only attributes and preserves legacy values without activating v2', () => {
	const plan = buildCatalogStagingPlan([category], [product])
	expect(plan).toHaveLength(2)
	expect(plan[0].fields.attribute_contract_version.after).toEqual({ exists: true, value: 1 })
	const defs = plan[0].fields.attribute_definitions.after
	if (!defs.exists) throw Error('Missing definitions')
	expect(defs.value).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'weight',
				value_type: 'string',
				is_required: true,
				unit: 'кг'
			}),
			expect.objectContaining({ key: 'material', filter_enabled: false })
		])
	)
	expect(product).not.toHaveProperty('attributes_v2')
	expect(plan[1].fields.attributes_v2.after).toEqual({
		exists: true,
		value: [
			{ k: 'weight', v: '1' },
			{ k: 'material', v: 'PLA' }
		]
	})
})
it('rejects mixed types, conflicting labels and staged fields', () => {
	expect(() =>
		buildCatalogStagingPlan(
			[category],
			[
				product,
				{
					...product,
					_id: new mongo.ObjectId(),
					attributes: [{ k: 'weight', l: 'Вага', v: 1 }]
				}
			]
		)
	).toThrow('STAGING_MIXED_TYPES')
	expect(() =>
		buildCatalogStagingPlan(
			[category],
			[
				product,
				{
					...product,
					_id: new mongo.ObjectId(),
					attributes: [{ k: 'weight', l: 'Інша назва', v: '1' }]
				}
			]
		)
	).toThrow('STAGING_LABEL_CONFLICT')
	expect(() => buildCatalogStagingPlan([{ ...category, parent_id: null }], [product])).toThrow(
		'STAGING_ALREADY_PRESENT'
	)
})
it('refuses guessing numeric range conversion or accepting orphan products', () => {
	expect(() =>
		buildCatalogStagingPlan(
			[
				{
					...category,
					required_attributes: [
						{ ...category.required_attributes[0], filter_type: 'range' }
					]
				}
			],
			[product]
		)
	).toThrow('STAGING_RANGE_MAPPING_REQUIRED')
	expect(() => buildCatalogStagingPlan([], [product])).toThrow('STAGING_ORPHAN_PRODUCT')
})

it('stages definitions only: no category presentation, no product or SKU names', () => {
	const plan = buildCatalogStagingPlan([{ ...category, slug: 'filament' }], [product])
	// Retired 2026-11-05: the product page reads the definitions themselves.
	expect(plan[0].fields).not.toHaveProperty('presentation')
	expect(
		plan.every(
			patch => !Object.hasOwn(patch.fields, 'name') && !Object.hasOwn(patch.fields, 'slug')
		)
	).toBe(true)
	expect(plan.some(patch => patch.collection === 'product_variants')).toBe(false)
})
