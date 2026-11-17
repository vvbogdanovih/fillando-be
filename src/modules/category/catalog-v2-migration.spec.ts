import { mongo } from 'mongoose'
import { buildV2MigrationPlan, migrationMappingSchema } from './catalog-v2-migration'

const id = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
const mapping = migrationMappingSchema.parse({
	category_slug: 'filament',
	brand_key: 'vyrobnyk',
	number_keys: ['vaha'],
	drop_product_keys: ['kolir'],
	axis: { key: 'color', label: 'Колір', semantic: 'color' },
	hidden_keys: ['material']
})
const category = () => ({
	_id: id(1),
	slug: 'filament',
	name: 'Філамент',
	required_attributes: [
		{
			key: 'vyrobnyk',
			label: 'Виробник',
			is_required: true,
			filter_type: 'multi-select',
			unit: null
		},
		{ key: 'vaha', label: 'Вага', is_required: true, filter_type: 'multi-select', unit: 'кг' },
		{
			key: 'polymer',
			label: 'Тип пластику',
			is_required: true,
			filter_type: 'multi-select',
			unit: null
		}
	]
})
const product = (n: number, extra: object = {}) => ({
	_id: id(n),
	category_id: id(1),
	attributes: [
		{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
		{ k: 'vaha', l: 'Вага', v: '1' },
		{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
		{ k: 'material', l: 'Матеріал', v: 'PLA Silk' },
		{ k: 'kolir', l: 'Колір', v: 'Чорний' }
	],
	...extra
})
const variant = (n: number, productId: number, color: number | null) => ({
	_id: id(n),
	product_id: id(productId),
	category_id: id(1),
	...(color === null ? {} : { color_id: id(color) })
})
const input = (overrides: object = {}) => ({
	category: category(),
	products: [product(10), product(11)],
	// Every product has a colour: the colour axis is required (owner, 2026-11-06).
	variants: [variant(20, 10, 90), variant(21, 10, 91), variant(22, 11, 92)],
	landings: [{ _id: id(40), category_id: id(1), filters: { polymer: ['PLA'], vaha: ['1'] } }],
	brandsByName: new Map([['Sunlu', id(80)]]),
	mapping,
	...overrides
})

describe('buildV2MigrationPlan', () => {
	it('maps brand, numbers, the colour axis, axis-less products and landings without touching identity', () => {
		const { patches, report } = buildV2MigrationPlan(input())
		const by = (collection: string, n: number) =>
			patches.find(row => row.collection === collection && row.id === String(id(n)))!
		const definitions = by('categories', 1).fields.attribute_definitions.after as {
			value: { key: string; value_type: string; semantic: string; filter_enabled: boolean }[]
		}
		expect(
			definitions.value.map(row => [
				row.key,
				row.value_type,
				row.semantic,
				row.filter_enabled
			])
		).toEqual([
			['vaha', 'number', 'generic', true],
			['polymer', 'string', 'generic', true],
			['material', 'string', 'generic', false],
			['color', 'string', 'color', false]
		])
		// The variation is required: every product of the category carries a colour.
		expect(definitions.value.find(row => row.key === 'color')).toMatchObject({
			is_required: true
		})
		expect(by('products', 10).fields).toMatchObject({
			attributes_v2: {
				after: {
					value: [
						{ k: 'vaha', v: 1 },
						{ k: 'polymer', v: 'PLA' },
						{ k: 'material', v: 'PLA Silk' }
					]
				}
			},
			variant_axis: { after: { value: { key: 'color' } } },
			brand_id: { after: { value: id(80) } }
		})
		expect(by('products', 11).fields.variant_axis.after).toEqual({
			exists: true,
			value: { key: 'color' }
		})
		expect(by('product_variants', 20).fields.variant_value.after).toEqual({
			exists: true,
			value: String(id(90))
		})
		expect(by('product_variants', 22).fields.variant_value.after).toEqual({
			exists: true,
			value: String(id(92))
		})
		expect(by('landings', 40).fields.filters_v2.after).toEqual({
			exists: true,
			value: {
				attributes: [
					{ key: 'polymer', values: ['PLA'] },
					{ key: 'vaha', values: [1] }
				],
				category_ids: [],
				brand_ids: [],
				color_families: []
			}
		})
		// Without a name addition only additive v2 fields: names, slugs, SKU codes, prices and
		// legacy fields untouched.
		const written = new Set(patches.flatMap(row => Object.keys(row.fields)))
		for (const field of [
			'name',
			'slug',
			'sku',
			'price',
			'stock',
			'attributes',
			'v_value',
			'filters'
		])
			expect(written.has(field)).toBe(false)
		expect(report).toMatchObject({
			products_with_axis: 2,
			products_without_axis: 0,
			variants: 3,
			brands: { Sunlu: 2 },
			dropped_product_attributes: { kolir: 2 }
		})
	})

	it('stops on a product without a colour beside a colour axis: name it in `sku_colors`', () => {
		expect(() =>
			buildV2MigrationPlan(
				input({
					variants: [variant(20, 10, 90), variant(21, 10, 91), variant(22, 11, null)]
				})
			)
		).toThrow('ATTRIBUTE_REQUIRED_VALUE')
	})

	it.each([
		[
			'AXIS_MAPPING_REQUIRED',
			{ variants: [variant(20, 10, 90), variant(21, 10, null), variant(22, 11, null)] }
		],
		['BRAND_NOT_MAPPED', { brandsByName: new Map() }],
		[
			'NOT_A_NUMBER',
			{
				products: [
					product(10, {
						attributes: [
							{ k: 'vyrobnyk', l: 'В', v: 'Sunlu' },
							{ k: 'vaha', l: 'В', v: 'один' },
							{ k: 'polymer', l: 'Т', v: 'PLA' }
						]
					}),
					product(11)
				]
			}
		],
		[
			'ATTRIBUTE_REQUIRED_VALUE',
			{
				products: [
					product(10, {
						attributes: [
							{ k: 'vyrobnyk', l: 'В', v: 'Sunlu' },
							{ k: 'vaha', l: 'В', v: '1' }
						]
					}),
					product(11)
				]
			}
		],
		[
			'LANDING_KEY_NOT_FILTERABLE',
			{ landings: [{ _id: id(40), filters: { material: ['PLA'] } }] }
		],
		['CATEGORY_NOT_FLAT_V1', { category: { ...category(), attribute_contract_version: 2 } }],
		[
			'ORPHAN_VARIANTS',
			{ variants: [variant(20, 10, 90), variant(22, 11, 92), variant(23, 99, null)] }
		],
		[
			'TARGET_ALREADY_HAS_V2_FIELD',
			{
				products: [
					product(10, { attributes_v2: [{ k: 'polymer', v: 'PETG' }] }),
					product(11)
				]
			}
		]
	])('stops on %s before any write', (code, overrides) => {
		expect(() => buildV2MigrationPlan(input(overrides))).toThrow(code)
	})

	it('leaves the legacy refill link alone: no product gets `relations`', () => {
		const { patches } = buildV2MigrationPlan(
			input({ products: [product(10), product(11, { spooled_product_id: id(10) })] })
		)
		for (const patch of patches.filter(row => row.collection === 'products'))
			expect(patch.fields.relations).toBeUndefined()
	})

	it('writes the purchase notice onto each matching product, not into the category', () => {
		const notice = {
			key: 'polymer',
			value: 'PLA',
			title: 'Це <b>рефіл</b>',
			text: 'Без котушки.',
			badge: 'Без котушки'
		}
		const withNotice = migrationMappingSchema.parse({ ...mapping, product_notices: [notice] })
		const other = (n: number) =>
			product(n, {
				attributes: [
					{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
					{ k: 'vaha', l: 'Вага', v: '1' },
					{ k: 'polymer', l: 'Тип пластику', v: 'PETG' }
				]
			})
		const { patches, report } = buildV2MigrationPlan(
			input({ mapping: withNotice, products: [product(10), other(11)] })
		)
		const fields = (n: number) =>
			patches.find(row => row.collection === 'products' && row.id === String(id(n)))!.fields
		expect(fields(10).purchase_notice.after).toEqual({
			exists: true,
			// Plain text, as the admin writes it.
			value: { title: 'Це рефіл', text: 'Без котушки.', badge: 'Без котушки' }
		})
		expect(fields(11)).not.toHaveProperty('purchase_notice')
		expect(patches[0].fields).not.toHaveProperty('presentation')
		expect(report.product_notices).toBe(1)
		const unknown = migrationMappingSchema.parse({
			...mapping,
			product_notices: [{ ...notice, key: 'nope' }]
		})
		expect(() => buildV2MigrationPlan(input({ mapping: unknown }))).toThrow(
			'MAPPING_UNKNOWN_KEY'
		)
	})

	it('sets the one table order, hides and marks definitions from the mapping', () => {
		const configured = migrationMappingSchema.parse({
			...mapping,
			definition_order: ['material', 'polymer'],
			hidden_keys: ['material'],
			semantics: { polymer: 'material' }
		})
		const { patches } = buildV2MigrationPlan(input({ mapping: configured }))
		const definitions = (
			patches[0].fields.attribute_definitions.after as {
				value: { key: string; order: number; visible_in_specs: boolean; semantic: string }[]
			}
		).value
		expect(
			definitions.map(row => [row.key, row.order, row.visible_in_specs, row.semantic])
		).toEqual([
			['material', 0, false, 'generic'],
			['polymer', 1, true, 'material'],
			['vaha', 2, true, 'generic'],
			['color', 3, true, 'color']
		])
		for (const bad of [
			{ hidden_keys: ['nope'] },
			{ definition_order: ['nope'] },
			{ semantics: { nope: 'brand' } }
		])
			expect(() =>
				buildV2MigrationPlan(
					input({ mapping: migrationMappingSchema.parse({ ...mapping, ...bad }) })
				)
			).toThrow('MAPPING_UNKNOWN_KEY')
	})

	it('does not carry a removed characteristic over at all (owner, 2026-11-06)', () => {
		const removing = migrationMappingSchema.parse({
			...mapping,
			hidden_keys: [],
			removed_keys: ['material']
		})
		const { patches, report } = buildV2MigrationPlan(input({ mapping: removing }))
		const definitions = (
			patches[0].fields.attribute_definitions.after as {
				value: { key: string; order: number }[]
			}
		).value
		expect(definitions.map(row => [row.key, row.order])).toEqual([
			['vaha', 0],
			['polymer', 1],
			['color', 2]
		])
		for (const n of [10, 11]) {
			const values = patches.find(
				row => row.collection === 'products' && row.id === String(id(n))
			)!.fields.attributes_v2.after as { value: { k: string }[] }
			expect(values.value.map(row => row.k)).not.toContain('material')
		}
		expect(report.removed_attributes).toEqual({ material: 2 })
		// The legacy values stay where they are: nothing writes `attributes`.
		expect(patches.some(row => 'attributes' in row.fields)).toBe(false)
		// A misspelt key would silently keep the characteristic.
		expect(() =>
			buildV2MigrationPlan(
				input({
					mapping: migrationMappingSchema.parse({ ...mapping, removed_keys: ['nope'] })
				})
			)
		).toThrow('MAPPING_UNKNOWN_KEY')
	})

	it('merges two spellings of one value on products and landing pins (Glow → Luminous)', () => {
		const merging = migrationMappingSchema.parse({
			...mapping,
			value_aliases: { polymer: { PLA: 'PLA+' } }
		})
		const { patches, report } = buildV2MigrationPlan(
			input({
				mapping: merging,
				landings: [
					{ _id: id(40), category_id: id(1), filters: { polymer: ['PLA', 'PLA+'] } }
				]
			})
		)
		const attributes = (n: number) =>
			(
				patches.find(row => row.collection === 'products' && row.id === String(id(n)))!
					.fields.attributes_v2.after as { value: { k: string; v: unknown }[] }
			).value
		expect(attributes(10)).toContainEqual({ k: 'polymer', v: 'PLA+' })
		expect(attributes(10)).not.toContainEqual({ k: 'polymer', v: 'PLA' })
		// The landing pinned both spellings: one value is left.
		expect(
			patches.find(row => row.collection === 'landings')!.fields.filters_v2.after
		).toMatchObject({ value: { attributes: [{ key: 'polymer', values: ['PLA+'] }] } })
		expect(report.merged_values).toEqual({ 'polymer:PLA→PLA+': 2 })
		expect(() =>
			buildV2MigrationPlan(
				input({
					mapping: migrationMappingSchema.parse({
						...mapping,
						value_aliases: { nope: { a: 'b' } }
					})
				})
			)
		).toThrow('MAPPING_UNKNOWN_KEY')
	})

	it('turns a text characteristic into a labelled list, keeping the stored values as ids', () => {
		const labelled = migrationMappingSchema.parse({
			...mapping,
			enum_labels: { polymer: { PETG: 'PETG (кополіестер)', PLA: 'PLA (полілактид)' } }
		})
		const { patches, report } = buildV2MigrationPlan(
			input({
				mapping: labelled,
				landings: [{ _id: id(40), category_id: id(1), filters: { polymer: ['PETG'] } }]
			})
		)
		const polymer = (
			patches[0].fields.attribute_definitions.after as {
				value: { key: string; value_type: string; options: unknown[] }[]
			}
		).value.find(row => row.key === 'polymer')!
		// Held by products (PLA) or pinned by a landing (PETG); by value, as the facets list them.
		expect(polymer).toMatchObject({
			value_type: 'enum',
			options: [
				{ id: 'PETG', label: 'PETG (кополіестер)', order: 0 },
				{ id: 'PLA', label: 'PLA (полілактид)', order: 1 }
			]
		})
		const product = patches.find(row => row.collection === 'products')!
		expect(product.fields.attributes_v2.after).toMatchObject({
			value: expect.arrayContaining([{ k: 'polymer', v: 'PLA' }]) as unknown
		})
		expect(report.enum_options).toEqual({ polymer: 2 })
		expect(() =>
			buildV2MigrationPlan(
				input({
					mapping: migrationMappingSchema.parse({
						...mapping,
						enum_labels: { vaha: { '1': 'Один' } }
					})
				})
			)
		).toThrow('ENUM_REQUIRES_TEXT')
	})

	it('puts a single uncoloured SKU on the colour axis from its product «Колір»', () => {
		const colors = [
			{ _id: id(95), name_uk: 'Чорний', name_en: 'Black', family: 'black' },
			{ _id: id(96), name_uk: 'Веселка', name_en: 'Rainbow', family: 'multicolor' }
		]
		const coloring = migrationMappingSchema.parse({
			...mapping,
			single_sku_color_key: 'kolir',
			color_aliases: { 'Матова веселка': 'Rainbow' }
		})
		const single = (n: number, colour: string) =>
			product(n, {
				name: `Single ${n}`,
				attributes: [
					{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
					{ k: 'vaha', l: 'Вага', v: '1' },
					{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
					{ k: 'kolir', l: 'Колір', v: colour }
				]
			})
		const run = (colour: string) =>
			buildV2MigrationPlan(
				input({
					mapping: coloring,
					colors,
					products: [product(10, { name: 'Sunlu PLA' }), single(11, colour)],
					variants: [
						{ ...variant(20, 10, 90), name: 'Sunlu PLA — Чорний (Black)' },
						{ ...variant(21, 10, 91), name: 'Sunlu PLA — Білий (White)' },
						{ ...variant(22, 11, null), name: 'Single 11', sku: 'FL-22', v_value: null }
					]
				})
			)
		const { patches, report } = run('Матова веселка')
		const field = (collection: string, n: number) =>
			patches.find(row => row.collection === collection && row.id === String(id(n)))!.fields
		expect(field('products', 11).variant_axis.after).toEqual({
			exists: true,
			value: { key: 'color' }
		})
		expect(field('product_variants', 22)).toMatchObject({
			variant_value: { after: { value: String(id(96)) } },
			color_id: { after: { value: id(96) } },
			color_family: { after: { value: 'multicolor' } },
			v_value: { before: { exists: true, value: null }, after: { value: 'Rainbow' } },
			name: { after: { value: 'Single 11 — Веселка (Rainbow)' } }
		})
		expect(report.colored_skus).toEqual({ 'FL-22': 'Rainbow' })
		// No product keeps the product-level «Колір»: no second «Колір» beside the axis.
		const definitions = (
			patches[0].fields.attribute_definitions.after as { value: { key: string }[] }
		).value.map(row => row.key)
		expect(definitions).not.toContain('kolir')
		expect(definitions).toContain('color')
		expect(() => run('Невідомий')).toThrow('COLOR_NOT_IN_DICTIONARY')
	})

	it('puts a single SKU without any colour on the axis with the colour the owner named', () => {
		const colors = [
			{ _id: id(95), name_uk: 'Чорний', name_en: 'Black', family: 'black' },
			{ _id: id(97), name_uk: 'Натуральне дерево', name_en: 'Natural Wood', family: 'brown' }
		]
		const bare = product(11, {
			name: 'Wood PLA',
			// No product-level «Колір» at all: nothing to read the colour from.
			attributes: [
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
				{ k: 'vaha', l: 'Вага', v: '1' },
				{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }
			]
		})
		const run = (skuColors: Record<string, string>) =>
			buildV2MigrationPlan(
				input({
					mapping: migrationMappingSchema.parse({ ...mapping, sku_colors: skuColors }),
					colors,
					products: [product(10, { name: 'Sunlu PLA' }), bare],
					variants: [
						{
							...variant(20, 10, 90),
							sku: 'FL-20',
							name: 'Sunlu PLA — Чорний (Black)'
						},
						{ ...variant(21, 10, 91), sku: 'FL-21', name: 'Sunlu PLA — Білий (White)' },
						{ ...variant(22, 11, null), name: 'Wood PLA', sku: 'FL-22', v_value: null }
					]
				})
			)
		const { patches, report } = run({ 'FL-22': 'Natural Wood' })
		const field = (collection: string, n: number) =>
			patches.find(row => row.collection === collection && row.id === String(id(n)))!.fields
		expect(field('products', 11).variant_axis.after).toEqual({
			exists: true,
			value: { key: 'color' }
		})
		expect(field('product_variants', 22)).toMatchObject({
			variant_value: { after: { value: String(id(97)) } },
			color_id: { after: { value: id(97) } },
			color_family: { after: { value: 'brown' } },
			v_value: { after: { value: 'Natural Wood' } },
			name: { after: { value: 'Wood PLA — Натуральне дерево (Natural Wood)' } }
		})
		expect(report.colored_skus).toEqual({ 'FL-22': 'Natural Wood' })
		expect(report.products_without_axis).toBe(0)
		// A misspelt code, or a SKU that already has a colour, never passes silently.
		expect(() => run({ 'FL-99': 'Black' })).toThrow('MAPPING_UNKNOWN_SKU')
		expect(() => run({ 'FL-20': 'Black' })).toThrow('SKU_COLOR_NOT_APPLICABLE')
		expect(() => run({ 'FL-22': 'Невідомий' })).toThrow('COLOR_NOT_IN_DICTIONARY')
	})

	it('writes the name addition into product and SKU names, before the variation', () => {
		const addition = 'Філамент (пластик для 3D-друку)'
		const named = migrationMappingSchema.parse({ ...mapping, product_name_addition: addition })
		const run = (products: object[], variants: object[]) =>
			buildV2MigrationPlan(input({ mapping: named, products, variants }))
		const { patches, report } = run(
			[
				product(10, { name: 'Kingroon PLA' }),
				product(11, { name: `Sunlu PETG — ${addition}` })
			],
			[
				{ ...variant(20, 10, 90), name: 'Kingroon PLA — Чорний (Black)' },
				{ ...variant(21, 10, 91), name: 'Kingroon PLA — Білий (White)' },
				{ ...variant(22, 11, 92), name: `Sunlu PETG — ${addition}` }
			]
		)
		const field = (collection: string, n: number) =>
			patches.find(row => row.collection === collection && row.id === String(id(n)))!.fields
		expect(field('products', 10).name).toEqual({
			before: { exists: true, value: 'Kingroon PLA' },
			after: { exists: true, value: `Kingroon PLA — ${addition}` }
		})
		expect(field('product_variants', 20).name.after).toEqual({
			exists: true,
			value: `Kingroon PLA — ${addition} — Чорний (Black)`
		})
		// A name that already says it is kept, and so are its SKU names.
		expect(field('products', 11)).not.toHaveProperty('name')
		expect(field('product_variants', 22)).not.toHaveProperty('name')
		expect(report).toMatchObject({ renamed_products: 1, renamed_variants: 2 })
		// A SKU named otherwise than «product — variation» is not guessed at.
		expect(() =>
			run(
				[product(10, { name: 'Kingroon PLA' }), product(11, { name: 'Sunlu PETG' })],
				[
					{ ...variant(20, 10, 90), name: 'Kingroon PLA — Чорний' },
					{ ...variant(21, 10, 91), name: 'Чорний Kingroon' },
					{ ...variant(22, 11, 92), name: 'Sunlu PETG' }
				]
			)
		).toThrow('VARIANT_NAME_NOT_PRODUCT_NAME')
	})
})
