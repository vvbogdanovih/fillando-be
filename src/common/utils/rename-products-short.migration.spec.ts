// The migration runs with plain `node`, so its pure helpers are exercised here. Two tests are
// load-bearing: the slug the rename writes must equal the one `ProductService` would write on
// the next ordinary save, and the committed dictionary must stay consistent with the rule.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rename = require('../../../scripts/fillando_v_2/rename-products-short.js') as {
	LONG_PREFIX: string
	proposeShortName: (name: unknown) => unknown
	isLongName: (name: unknown) => boolean
	plannedVariant: (
		variant: Variant,
		oldProductName: string,
		newProductName: string,
		color?: { name_uk?: string; name_en?: string }
	) => Planned
	planProducts: (
		products: Product[],
		variants: Variant[],
		colorById: Map<string, { name_uk?: string; name_en?: string }>,
		shortNames: Record<string, string>
	) => Plan
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SHORT_NAMES, REVIEWED_EDITS } = require('../../../scripts/fillando_v_2/short-names.js') as {
	SHORT_NAMES: Record<string, string>
	REVIEWED_EDITS: string[]
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateSlug } = require('../../../scripts/fillando_v_2/normalize-variant-colors.js') as {
	generateSlug: (text: string) => string
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SUFFIX } = require('../../../scripts/fillando_v_2/split-refill-products.js') as {
	SUFFIX: string
}

interface Variant {
	_id: string
	sku: string
	product_id: string
	slug: string
	name?: string
	v_value?: string | null
	color_id?: string | null
}
interface Product {
	_id: string
	name: string
}
interface Planned {
	_id: string
	sku: string
	old_slug: string
	new_slug: string
	old_name: string
	new_name: string
	rebuilt: boolean
	parked: boolean
}
interface Plan {
	renamed: { product_id: string; old_name: string; new_name: string; variants: Planned[] }[]
	already_done: { product_id: string; name: string }[]
	unmapped: { product_id: string; name: string }[]
	collisions: { product_id: string; product: string; slug: string; skus: string[] }[]
	taken: { slug: string; skus: string[]; reason: string }[]
}

const P = rename.LONG_PREFIX

describe('proposeShortName — the strip rule against the real catalogue names', () => {
	it.each([
		[`${P}Kingroon PLA Silk Rainbow 1,75 мм 1 кг`, 'Kingroon PLA Silk Rainbow'],
		[`${P}Kingroon PETG (CoPET) 1,75 мм 1 кг`, 'Kingroon PETG (CoPET)'],
		// The weight stays when it is not the default: it is what tells the two reels apart.
		[`${P}Kingroon PETG (CoPET) 1,75 мм 3 кг`, 'Kingroon PETG (CoPET) 3 кг'],
		[
			`${P}Kingroon PETG (CoPET) 1,75 мм 1 кг (еко-пакування)`,
			'Kingroon PETG (CoPET) (еко-пакування)'
		],
		[`${P}Bambu Lab TPU для AMS 1,75 мм 1 кг`, 'Bambu Lab TPU для AMS'],
		[`${P}Kingroon PA6 Nylon (нейлон) 1,75 мм 1 кг`, 'Kingroon PA6 Nylon (нейлон)'],
		[
			`${P}Bambu Lab PETG Translucent (напівпрозорий) 1,75 мм 1 кг`,
			'Bambu Lab PETG Translucent (напівпрозорий)'
		],
		[`${P}Sunlu Wood PLA 1,75 мм 1 кг`, 'Sunlu Wood PLA'],
		[`${P}Kingroon PA-CF 15% 1,75 мм 1 кг`, 'Kingroon PA-CF 15%'],
		[`${P}Bambu Lab PLA Silk+ 1,75 мм 1 кг`, 'Bambu Lab PLA Silk+'],
		// The refill suffix survives: without it the refill would share its parent's name.
		[
			`${P}Bambu Lab PETG Translucent (напівпрозорий) 1,75 мм 1 кг${SUFFIX}`,
			`Bambu Lab PETG Translucent (напівпрозорий)${SUFFIX}`
		]
	])('«%s» → «%s»', (long, short) => {
		expect(rename.proposeShortName(long)).toBe(short)
	})

	it('leaves a name without the prefix alone — it is already short', () => {
		expect(rename.proposeShortName('Kingroon PLA')).toBe('Kingroon PLA')
		expect(rename.isLongName('Kingroon PLA')).toBe(false)
		expect(rename.isLongName(`${P}Kingroon PLA 1,75 мм 1 кг`)).toBe(true)
	})

	it('does not strip a diameter or weight the shop does not sell by default', () => {
		expect(rename.proposeShortName(`${P}Kingroon PLA 2,85 мм 0,5 кг`)).toBe(
			'Kingroon PLA 2,85 мм 0,5 кг'
		)
	})
})

describe('short-names.js — the committed dictionary', () => {
	const entries = Object.entries(SHORT_NAMES)

	it('covers the 43 products of the dev catalogue plus the refill step 3d creates', () => {
		expect(entries.length).toBe(44)
	})

	it('has unique short names, none carrying the long prefix', () => {
		const values = entries.map(([, v]) => v)
		expect(new Set(values).size).toBe(values.length)
		for (const value of values) expect(rename.isLongName(value)).toBe(false)
	})

	it('equals the rule everywhere except the reviewed edits, which must really differ', () => {
		const edited = new Set(REVIEWED_EDITS)
		for (const [long, short] of entries) {
			if (edited.has(long)) expect(rename.proposeShortName(long)).not.toBe(short)
			else expect(rename.proposeShortName(long)).toBe(short)
		}
		for (const long of REVIEWED_EDITS) expect(SHORT_NAMES).toHaveProperty(long)
	})
})

describe('plannedVariant — mirrors ProductService on a rename', () => {
	const long = `${P}Kingroon PLA Silk 1,75 мм 1 кг`
	const short = 'Kingroon PLA Silk'

	it('keeps the colour suffix the colour step wrote and re-slugs from the short name', () => {
		const planned = rename.plannedVariant(
			{
				_id: 'v1',
				sku: 'FL-1',
				product_id: 'p1',
				slug: generateSlug(`${long} Gold`),
				name: `${long} — Золотий (Gold)`,
				v_value: 'Gold'
			},
			long,
			short
		)
		expect(planned.new_name).toBe('Kingroon PLA Silk — Золотий (Gold)')
		expect(planned.new_slug).toBe(generateSlug('Kingroon PLA Silk Gold'))
		expect(planned.new_slug).toBe('kingroon-pla-silk-gold')
		expect(planned.rebuilt).toBe(false)
	})

	it('rebuilds a name that does not start with the product name, from the dictionary colour', () => {
		const planned = rename.plannedVariant(
			{
				_id: 'v2',
				sku: 'FL-2',
				product_id: 'p1',
				slug: 'old',
				name: 'hand-edited',
				v_value: 'Gold'
			},
			long,
			short,
			{ name_uk: 'Золотий', name_en: 'Gold' }
		)
		expect(planned.new_name).toBe('Kingroon PLA Silk — Золотий (Gold)')
		expect(planned.rebuilt).toBe(true)
	})

	it('falls back to the raw value when there is no dictionary colour', () => {
		const planned = rename.plannedVariant(
			{ _id: 'v3', sku: 'FL-3', product_id: 'p1', slug: 'old', name: 'x', v_value: 'Candy' },
			long,
			short
		)
		expect(planned.new_name).toBe('Kingroon PLA Silk — Candy')
	})

	it('recognises a variant a crashed run left parked', () => {
		const planned = rename.plannedVariant(
			{
				_id: 'v4',
				sku: 'FL-4',
				product_id: 'p1',
				slug: 'kingroon-pla-silk-gold-moving-v4',
				v_value: 'Gold'
			},
			long,
			short
		)
		expect(planned.parked).toBe(true)
	})
})

describe('planProducts — vetting before the first write', () => {
	const longA = `${P}Kingroon PLA Silk 1,75 мм 1 кг`
	const longB = `${P}Kingroon PLA Silk Rainbow 1,75 мм 1 кг`
	const names = { [longA]: 'Kingroon PLA Silk', [longB]: 'Kingroon PLA Silk Rainbow' }
	const variant = (id: string, product_id: string, v_value: string, slug: string): Variant => ({
		_id: id,
		sku: id,
		product_id,
		slug,
		name: `${product_id} — ${v_value}`,
		v_value
	})

	it('renames mapped products, skips short ones and refuses unmapped ones', () => {
		const plan = rename.planProducts(
			[
				{ _id: 'a', name: longA },
				{ _id: 'done', name: 'Sunlu PLA' },
				{ _id: 'x', name: `${P}Unknown 1,75 мм 1 кг` }
			],
			[variant('FL-1', 'a', 'Gold', 'old-1')],
			new Map(),
			names
		)
		expect(plan.renamed.map(r => r.new_name)).toEqual(['Kingroon PLA Silk'])
		expect(plan.already_done.map(d => d.name)).toEqual(['Sunlu PLA'])
		expect(plan.unmapped.map(u => u.name)).toEqual([`${P}Unknown 1,75 мм 1 кг`])
	})

	it('reports the Candy pair as a collision inside the product and leaves that product long', () => {
		const plan = rename.planProducts(
			[{ _id: 'b', name: longB }],
			[
				variant('FL-000157', 'b', 'Candy', 'old-157'),
				variant('FL-000162', 'b', 'Candy', 'old-162')
			],
			new Map(),
			names
		)
		expect(plan.renamed).toEqual([])
		expect(plan.collisions).toEqual([
			{
				product_id: 'b',
				product: longB,
				slug: 'kingroon-pla-silk-rainbow-candy',
				skus: ['FL-000157', 'FL-000162']
			}
		])
	})

	it('detects an address wanted by two products — «PLA Silk» + «Rainbow X» meets «PLA Silk Rainbow» + «X»', () => {
		const plan = rename.planProducts(
			[
				{ _id: 'a', name: longA },
				{ _id: 'b', name: longB }
			],
			[variant('FL-1', 'a', 'Rainbow Red', 'old-1'), variant('FL-2', 'b', 'Red', 'old-2')],
			new Map(),
			names
		)
		expect(plan.taken).toEqual([
			{
				slug: 'kingroon-pla-silk-rainbow-red',
				skus: ['FL-1', 'FL-2'],
				reason: 'planned twice'
			}
		])
	})

	it('detects an address already held by a variant outside the plan', () => {
		const plan = rename.planProducts(
			[
				{ _id: 'a', name: longA },
				{ _id: 'other', name: 'Some short product' }
			],
			[
				variant('FL-1', 'a', 'Gold', 'old-1'),
				variant('FL-9', 'other', 'x', 'kingroon-pla-silk-gold')
			],
			new Map(),
			names
		)
		expect(plan.taken[0]).toMatchObject({
			slug: 'kingroon-pla-silk-gold',
			reason: 'held by a variant outside the plan'
		})
	})
})
