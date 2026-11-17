import { AttributeDefinition } from './attribute-definitions'
import {
	assertDataStaysValid,
	CategoryData,
	checkDefinitionChange,
	DefinitionChangeError,
	definitionUsage
} from './category-definition-change'

const base = {
	unit: null,
	is_required: false,
	filter_enabled: true,
	filter_type: 'multi-select' as const,
	visible_in_specs: true,
	multiple: false,
	semantic: 'generic' as const,
	options: []
}
const polymer: AttributeDefinition = {
	...base,
	key: 'polymer',
	label: 'Тип пластику',
	value_type: 'enum',
	is_required: true,
	order: 0,
	options: [
		{ id: 'pla', label: 'PLA', order: 0 },
		{ id: 'petg', label: 'PETG', order: 1 },
		{ id: 'abs', label: 'ABS', order: 2 }
	]
}
const weight: AttributeDefinition = {
	...base,
	key: 'vaha',
	label: 'Вага',
	value_type: 'number',
	unit: 'г',
	filter_type: 'range',
	order: 1
}
const colour: AttributeDefinition = {
	...base,
	key: 'color',
	label: 'Колір',
	value_type: 'string',
	filter_enabled: false,
	filter_type: null,
	semantic: 'color',
	order: 2
}
const note: AttributeDefinition = {
	...base,
	key: 'note',
	label: 'Примітка',
	value_type: 'string',
	filter_enabled: false,
	filter_type: null,
	order: 3
}
const unused: AttributeDefinition = { ...note, key: 'unused', label: 'Порожня', order: 4 }
const before = [polymer, weight, colour, note, unused]
const data: CategoryData = {
	products: [
		{
			id: 'p1',
			attributes_v2: [
				{ k: 'polymer', v: 'pla' },
				{ k: 'vaha', v: 1000 }
			],
			variant_axis: { key: 'color' }
		},
		{
			id: 'p2',
			attributes_v2: [
				{ k: 'polymer', v: 'petg' },
				{ k: 'note', v: 'Без котушки' }
			],
			variant_axis: null
		}
	],
	variants: [
		{ id: 'v1', product_id: 'p1', variant_value: 'black' },
		{ id: 'v2', product_id: 'p1', variant_value: 'white' },
		{ id: 'v3', product_id: 'p2', variant_value: null }
	],
	landings: [
		{ id: 'l1', filters_v2: { attributes: [{ key: 'polymer', values: ['pla'] }] } },
		{ id: 'l2', filters_v2: { attributes: [], color_families: ['black'] } }
	]
}
const usage = definitionUsage(before, data)
const published = { published: true }
const refused = (next: AttributeDefinition[], options = published) => {
	try {
		checkDefinitionChange(before, next, usage, options)
	} catch (error) {
		expect(error).toBeInstanceOf(DefinitionChangeError)
		return error as DefinitionChangeError
	}
	throw Error('expected a refusal')
}
const replace = (patch: Partial<AttributeDefinition>, key = patch.key ?? 'polymer') =>
	before.map(definition => (definition.key === key ? { ...definition, ...patch } : definition))

it('counts exactly who holds or pins each key and option', () => {
	expect(usage.products).toBe(2)
	expect(usage.keys.polymer).toMatchObject({
		products: 2,
		variants: 0,
		landings: 1,
		pins: 1,
		missing: 0
	})
	expect(usage.keys.polymer.options).toEqual({
		pla: { products: 1, variants: 0, landings: 1 },
		petg: { products: 1, variants: 0, landings: 0 },
		abs: { products: 0, variants: 0, landings: 0 }
	})
	// The axis: one product, its two SKUs, and the colour-family landing depends on it.
	expect(usage.keys.color).toMatchObject({ products: 1, variants: 2, landings: 1, pins: 0 })
	expect(usage.keys.vaha).toMatchObject({ products: 1, missing: 1 })
	expect(usage.keys.note).toMatchObject({ products: 1 })
	expect(usage.keys.unused).toMatchObject({
		products: 0,
		variants: 0,
		landings: 0,
		missing: 2
	})
})

it('counts an enum axis option on the products whose SKUs carry it', () => {
	const size: AttributeDefinition = {
		...polymer,
		key: 'size',
		options: [
			{ id: 's', label: 'S', order: 0 },
			{ id: 'm', label: 'M', order: 1 }
		]
	}
	const result = definitionUsage([size], {
		...data,
		products: [{ id: 'p', attributes_v2: [], variant_axis: { key: 'size' } }],
		variants: [
			{ id: 'a', product_id: 'p', variant_value: 's' },
			{ id: 'b', product_id: 'p', variant_value: 's' }
		],
		landings: []
	})
	expect(result.keys.size.options.s).toEqual({ products: 1, variants: 2, landings: 0 })
	expect(result.keys.size.options.m).toEqual({ products: 0, variants: 0, landings: 0 })
})

it('allows renames, units, order, spec visibility, new options and new optional keys on a published category', () => {
	const next = [
		{ ...polymer, label: 'Полімер', order: 5, visible_in_specs: false },
		{ ...weight, label: 'Вага котушки' },
		colour,
		note,
		// The unit of a key nothing holds a value of (the unit of a held one is locked, below).
		{ ...unused, unit: 'шт' },
		{ ...note, key: 'a_new', label: 'Діаметр', is_required: false }
	]
	next[0] = {
		...next[0],
		options: [
			{ id: 'pla', label: 'PLA+', order: 2 },
			{ id: 'petg', label: 'PETG', order: 0 },
			{ id: 'abs', label: 'ABS', order: 1 },
			{ id: 'asa', label: 'ASA', order: 3 }
		]
	}
	expect(() => checkDefinitionChange(before, next, usage, published)).not.toThrow()
	expect(() => assertDataStaysValid(before, next, data, published)).not.toThrow()
})

it('allows what nothing uses: an unused option, an unused key, its type, an unpinned filter', () => {
	const next = [
		{ ...polymer, options: polymer.options.slice(0, 2) },
		{ ...weight, filter_enabled: false, filter_type: null },
		colour,
		{ ...note, is_required: false }
	]
	expect(() => checkDefinitionChange(before, next, usage, published)).not.toThrow()
	expect(() =>
		checkDefinitionChange(
			before,
			replace({ key: 'unused', value_type: 'number', unit: 'мм' }),
			usage,
			published
		)
	).not.toThrow()
})

it('refuses removal of a used key with the exact counts', () => {
	const removed = refused(before.filter(definition => definition.key !== 'polymer'))
	expect(removed).toMatchObject({
		code: 'DEFINITION_IN_USE',
		key: 'polymer',
		label: 'Тип пластику',
		usage: { products: 2, variants: 0, landings: 1 }
	})
	expect(refused(before.filter(definition => definition.key !== 'color')).usage).toEqual({
		products: 1,
		variants: 2,
		landings: 1
	})
	// Nothing holds or pins it: a characteristic no product uses may go (no category card
	// settings name keys since 2026-11-05).
	const unused = definitionUsage(before, { ...data, products: [], variants: [], landings: [] })
	expect(() =>
		checkDefinitionChange(
			before,
			before.filter(definition => definition.key !== 'vaha'),
			unused,
			published
		)
	).not.toThrow()
})

it('refuses a type or cardinality change of a used key, and its move into or out of the colour', () => {
	for (const options of [published, { published: false }]) {
		for (const patch of [{ value_type: 'string' as const, options: [] }, { multiple: true }])
			expect(refused(replace(patch), options)).toMatchObject({
				code: 'DEFINITION_TYPE_LOCKED',
				key: 'polymer'
			})
		expect(refused(replace({ key: 'color', semantic: 'generic' }), options).code).toBe(
			'DEFINITION_TYPE_LOCKED'
		)
		expect(
			refused(
				replace({
					key: 'note',
					semantic: 'color',
					filter_enabled: false,
					filter_type: null
				}),
				options
			).code
		).toBe('DEFINITION_TYPE_LOCKED')
	}
})

it('lets a used key change its meaning: the values stay as they are (owner, 2026-11-08)', () => {
	for (const options of [published, { published: false }])
		for (const semantic of ['brand', 'material', 'size', 'generic'] as const)
			expect(() =>
				checkDefinitionChange(before, replace({ semantic }), usage, options)
			).not.toThrow()
})

it('refuses a unit change of a key a product or SKU holds a value of, allows it otherwise', () => {
	// `vaha` is held by a product in this fixture; the change would reinterpret its stored values.
	const vaha = before.find(definition => definition.key === 'vaha')!
	const recut = before.map(definition =>
		definition.key === 'vaha'
			? { ...definition, unit: vaha.unit === 'кг' ? 'г' : 'кг' }
			: definition
	)
	for (const options of [published, { published: false }])
		expect(refused(recut, options)).toMatchObject({
			code: 'DEFINITION_UNIT_LOCKED',
			key: 'vaha'
		})
	// No value anywhere — only landing pins name it: the unit may change.
	const none = definitionUsage(before, { ...data, products: [], variants: [] })
	expect(() => checkDefinitionChange(before, recut, none, published)).not.toThrow()
})

it('refuses removal of a used option, naming the option and its usage', () => {
	expect(
		refused(replace({ options: polymer.options.filter(option => option.id !== 'pla') }))
	).toMatchObject({
		code: 'OPTION_IN_USE',
		option: { id: 'pla', label: 'PLA' },
		usage: { products: 1, variants: 0, landings: 1 }
	})
})

it('refuses a filter change of a key landings pin', () => {
	expect(refused(replace({ filter_enabled: false, filter_type: null }))).toMatchObject({
		code: 'FILTER_PINNED',
		usage: { landings: 1 }
	})
})

it('refuses requirements published products cannot meet, and allows them in a draft', () => {
	expect(refused(replace({ key: 'vaha', is_required: true }))).toMatchObject({
		code: 'REQUIRED_VALUES_MISSING',
		key: 'vaha',
		usage: { products: 1 }
	})
	const added = [...before, { ...note, key: 'a_new', label: 'Діаметр', is_required: true }]
	expect(refused(added)).toMatchObject({
		code: 'REQUIRED_VALUES_MISSING',
		label: 'Діаметр',
		usage: { products: 2 }
	})
	expect(() => checkDefinitionChange(before, added, usage, { published: false })).not.toThrow()
	// Every product already holds the value: the requirement is met.
	expect(() =>
		checkDefinitionChange(before, replace({ key: 'note', is_required: true }), usage, {
			published: true
		})
	).toThrow(DefinitionChangeError)
	const complete = definitionUsage(before, {
		...data,
		products: data.products.map(product => ({
			...product,
			attributes_v2: [...(product.attributes_v2 as object[]), { k: 'note', v: 'x' }]
		}))
	})
	expect(() =>
		checkDefinitionChange(before, replace({ key: 'note', is_required: true }), complete, {
			published: true
		})
	).not.toThrow()
})

it('stops anything that would invalidate data valid before, but not rows invalid already', () => {
	const next = replace({ options: polymer.options.filter(option => option.id !== 'petg') })
	let refusal: unknown
	try {
		assertDataStaysValid(before, next, data, published)
	} catch (error) {
		refusal = error
	}
	expect(refusal).toMatchObject({
		code: 'DEFINITION_CHANGE_INVALIDATES_DATA',
		usage: { products: 1, variants: 0, landings: 0 }
	})
	const broken: CategoryData = {
		...data,
		products: [...data.products, { id: 'old', attributes_v2: [{ k: 'gone', v: 1 }] }]
	} as CategoryData
	expect(() =>
		assertDataStaysValid(before, replace({ label: 'Полімер' }), broken, published)
	).not.toThrow()
})

it('keeps a variation required while SKUs vary by it (owner, 2026-11-06)', () => {
	const required = before.map(definition =>
		definition.key === 'color' ? { ...definition, is_required: true } : definition
	)
	const axisUsage = definitionUsage(required, data)
	const optional = required.map(definition =>
		definition.key === 'color' ? { ...definition, is_required: false } : definition
	)
	let refusal: unknown
	try {
		checkDefinitionChange(required, optional, axisUsage, { published: false })
	} catch (error) {
		refusal = error
	}
	expect(refusal).toMatchObject({ code: 'AXIS_REQUIRED', key: 'color', usage: { variants: 2 } })
	// A characteristic no SKU varies by may be made optional.
	const noteRequired = required.map(definition =>
		definition.key === 'note' ? { ...definition, is_required: true } : definition
	)
	expect(() =>
		checkDefinitionChange(noteRequired, required, definitionUsage(noteRequired, data), {
			published: false
		})
	).not.toThrow()
})
