import { compareFacetValues, mergeFacetValues } from './facet.utils'

describe('compareFacetValues', () => {
	it('orders numeric values by magnitude, not as strings', () => {
		expect(['3', '1', '0.5', '10'].sort(compareFacetValues)).toEqual(['0.5', '1', '3', '10'])
		expect(['2.85', '1.75'].sort(compareFacetValues)).toEqual(['1.75', '2.85'])
	})

	it('puts numbers before words', () => {
		expect(['Silk', '1', 'ABS'].sort(compareFacetValues)).toEqual(['1', 'ABS', 'Silk'])
	})

	it('sorts words with the Ukrainian collator: Cyrillic first, case folded', () => {
		expect(['Так', 'silk', 'Ні (рефіл)', 'Matte'].sort(compareFacetValues)).toEqual([
			'Ні (рефіл)',
			'Так',
			'Matte',
			'silk'
		])
	})

	it('treats a value with a unit as a word, since the unit belongs to the dimension', () => {
		expect(['1 кг', '3'].sort(compareFacetValues)).toEqual(['3', '1 кг'])
	})

	it('is deterministic for strings the collator considers equal', () => {
		expect(compareFacetValues('silk', 'Silk')).toBe(-compareFacetValues('Silk', 'silk'))
		expect(compareFacetValues('PLA', 'PLA')).toBe(0)
	})
})

describe('mergeFacetValues', () => {
	it('keeps every value of the category, with 0 where the narrowing has none', () => {
		const merged = mergeFacetValues(
			['PETG', 'PLA', 'Wood'],
			new Map([
				['PLA', 24],
				['PETG', 3]
			])
		)
		expect(merged).toEqual([
			{ value: 'PETG', count: 3 },
			{ value: 'PLA', count: 24 },
			{ value: 'Wood', count: 0 }
		])
	})

	it('drops empty strings and collapses duplicates', () => {
		expect(mergeFacetValues(['', 'PLA', 'PLA'], new Map([['PLA', 1]]))).toEqual([
			{ value: 'PLA', count: 1 }
		])
	})

	it('returns numeric values in numeric order', () => {
		const merged = mergeFacetValues(['3', '1', '0.5'], new Map([['1', 300]]))
		expect(merged.map(v => v.value)).toEqual(['0.5', '1', '3'])
	})
})
