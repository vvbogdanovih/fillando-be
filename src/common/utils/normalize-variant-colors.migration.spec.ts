import { generateSlug } from './attribute.utils'

/* eslint-disable @typescript-eslint/no-require-imports */
const seed = require('../../../scripts/migrations/seed-colors.js') as {
	COLORS: {
		name_en: string
		name_uk: string
		family: string
		hex_stops: string[]
		synonyms?: string[]
	}[]
	normalizeColorValue: (value: unknown) => string | null
	aliasesFor: (color: { name_en: string; name_uk: string; synonyms?: string[] }) => string[]
	buildAliasIndex: (colors: unknown[]) => Map<string, string>
	slugFor: (nameEn: string) => string
}
const normalizer = require('../../../scripts/migrations/normalize-variant-colors.js') as {
	generateSlug: (text: string) => string
	isColorAxis: (variantType: unknown) => boolean
	buildIndex: (colorDocs: unknown[]) => Map<string, { name_en: string }>
	matchColor: (index: Map<string, unknown>, value: unknown) => { name_en: string } | null
}
/* eslint-enable @typescript-eslint/no-require-imports */

const FAMILIES = [
	'black',
	'white',
	'gray',
	'red',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
	'pink',
	'brown',
	'gold',
	'silver',
	'transparent',
	'multicolor'
]

describe('the colour dictionary', () => {
	it('uses only the 15 families the schema allows', () => {
		for (const color of seed.COLORS) expect(FAMILIES).toContain(color.family)
	})

	it('gives every colour at least one and at most six #rrggbb stops', () => {
		for (const color of seed.COLORS) {
			expect(color.hex_stops.length).toBeGreaterThanOrEqual(1)
			expect(color.hex_stops.length).toBeLessThanOrEqual(6)
			for (const stop of color.hex_stops) expect(stop).toMatch(/^#[0-9a-f]{6}$/i)
		}
	})

	it('keeps name_en unique — the normalizer matches on it', () => {
		const names = seed.COLORS.map(c => c.name_en)
		expect(new Set(names).size).toBe(names.length)
	})

	it('produces a unique slug per colour', () => {
		const slugs = seed.COLORS.map(c => seed.slugFor(c.name_en))
		expect(new Set(slugs).size).toBe(slugs.length)
		for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/)
	})

	it('has no spelling claimed by two different colours', () => {
		// buildAliasIndex throws on a conflict — a silent one would send variants to the wrong
		// colour, which is unrecoverable once v_value has been overwritten.
		expect(() => seed.buildAliasIndex(seed.COLORS)).not.toThrow()
	})

	it('refuses a dictionary where two colours share a spelling', () => {
		const clashing = [
			{ name_en: 'Red', name_uk: 'Червоний', synonyms: [] },
			{ name_en: 'Crimson', name_uk: 'Червоний', synonyms: [] }
		]
		expect(() => seed.buildAliasIndex(clashing)).toThrow(/claimed by both/)
	})
})

describe('normalizeColorValue', () => {
	it.each([
		['  Чорний  ', 'Чорний'],
		['Black\tЧорний', 'Black Чорний'],
		['Black   Чорний', 'Black Чорний'],
		['Clear Безбарвний Refill', 'Clear Безбарвний'],
		['Колір: Чорний', 'Чорний'],
		['color - Black', 'Black']
	])('normalizes %p to %p', (input, expected) => {
		expect(seed.normalizeColorValue(input)).toBe(expected)
	})

	it('folds the two apostrophes the data mixes for one word', () => {
		expect(seed.normalizeColorValue('М’ятний')).toBe(seed.normalizeColorValue("М'ятний"))
	})

	it.each([[''], ['   '], [null], [undefined], [42]])('returns null for %p', value => {
		expect(seed.normalizeColorValue(value)).toBeNull()
	})
})

describe('aliasesFor', () => {
	const color = { name_en: 'Silver', name_uk: 'Сріблястий', synonyms: ['Срібний'] }

	it('recognises the English name, the Ukrainian name and both orders of the pair', () => {
		const aliases = seed.aliasesFor(color)

		expect(aliases).toEqual(
			expect.arrayContaining([
				'silver',
				'сріблястий',
				'silver сріблястий',
				'сріблястий silver',
				'срібний'
			])
		)
	})

	it('lower-cases every alias, so matching is case-insensitive', () => {
		for (const alias of seed.aliasesFor(color)) expect(alias).toBe(alias.toLowerCase())
	})
})

describe('isColorAxis', () => {
	it.each([
		['the key the design assumed', { key: 'color', label: 'Colour' }],
		['the key this database actually stores', { key: 'kolir', label: 'Колір' }],
		['an unexpected key with a Ukrainian label', { key: 'shade', label: 'Колір' }],
		['a Russian label', { key: 'x', label: 'Цвет' }]
	])('accepts %s', (_case, variantType) => {
		expect(normalizer.isColorAxis(variantType)).toBe(true)
	})

	it.each([
		['a size axis', { key: 'rozmir', label: 'Розмір' }],
		['no variant type', undefined],
		['null', null],
		['a string', 'color']
	])('rejects %s', (_case, variantType) => {
		expect(normalizer.isColorAxis(variantType)).toBe(false)
	})
})

describe('matchColor', () => {
	const docs = [
		{ _id: '1', name_en: 'Silver', name_uk: 'Сріблястий', family: 'silver' },
		{ _id: '2', name_en: 'Black', name_uk: 'Чорний', family: 'black' }
	]
	const index = normalizer.buildIndex(docs)

	it.each([
		['Сріблястий', 'Silver'],
		['Срібний', 'Silver'],
		['silver', 'Silver'],
		['Black Чорний', 'Black'],
		['  чорний ', 'Black']
	])('matches %p to %s', (value, expected) => {
		expect(normalizer.matchColor(index, value)?.name_en).toBe(expected)
	})

	it('carries synonyms that are not stored on the document itself', () => {
		// The `colors` collection has no `synonyms` field; indexing the documents alone would
		// silently drop every irregular spelling, which is most of this shop's data.
		expect(docs[0]).not.toHaveProperty('synonyms')
		expect(normalizer.matchColor(index, 'Срібний')?.name_en).toBe('Silver')
	})

	it.each([['Macaron'], ['TR-1'], [null], ['']])(
		'leaves %p unmatched rather than guessing',
		value => {
			expect(normalizer.matchColor(index, value)).toBeNull()
		}
	)
})

describe('the duplicated generateSlug', () => {
	it.each([
		'Філамент Kingroon PLA Basic Black',
		'PETG Translucent Clear',
		'Тест — з тире та  пробілами',
		"Апостроф'ований Wood",
		'ЖЖЄЇҐ Ukr'
	])('produces the same slug as the API for %p', text => {
		// The migration writes slugs the API must reproduce on the next save; a drift here
		// would change every address again the first time an admin edits the product.
		expect(normalizer.generateSlug(text)).toBe(generateSlug(text))
	})
})
