/**
 * The mapping table is the whole migration: a wrong row silently mislabels a product, and the
 * only symptom is that it stops appearing under a filter. These tests pin TD-0002 §5.2.1 —
 * all 29 rows, the shape of the derived entries, and the rules that keep a re-run safe.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../scripts/migrations/derive-material-taxonomy.js') as {
	TAXONOMY: Record<
		string,
		{ polymer: string; finish: string[]; reinforcement: string | null; series: string }
	>
	KEYS: Record<string, string>
	normalizeMaterial: (value: unknown) => string | null
	lookupTaxonomy: (value: unknown) => { polymer: string } | null
	deriveAttributes: (attributes: unknown) => {
		attributes: { k: string; l: string; v: string }[] | null
		material: string | null
		matched: boolean
	}
	rebuildRequiredAttributes: (
		required: unknown
	) => { key: string; label: string; filter_type: string; unit: null }[] | null
}

const attrs = (...rows: [string, string, string][]) => rows.map(([k, l, v]) => ({ k, l, v }))

describe('the taxonomy table', () => {
	it('covers all 29 materials of TD-0002 §5.2.1', () => {
		expect(Object.keys(migration.TAXONOMY)).toHaveLength(29)
	})

	it('produces the value counts the design predicted', () => {
		const rows = Object.values(migration.TAXONOMY)
		const distinct = (values: string[]) => new Set(values.filter(Boolean)).size

		expect(distinct(rows.map(r => r.polymer))).toBe(7)
		expect(distinct(rows.flatMap(r => r.finish))).toBe(10)
		expect(distinct(rows.map(r => r.reinforcement ?? ''))).toBe(2)
		expect(distinct(rows.map(r => r.series))).toBe(4)
	})

	it('gives every material a polymer and a series', () => {
		for (const [material, row] of Object.entries(migration.TAXONOMY)) {
			expect(row.polymer).toBeTruthy()
			expect(row.series).toBeTruthy()
			expect(Array.isArray(row.finish)).toBe(true)
			expect(material.trim()).toBe(material)
		}
	})

	it('never lets a value carry a comma, which the catalogue query splits on', () => {
		for (const row of Object.values(migration.TAXONOMY)) {
			const values = [row.polymer, row.series, row.reinforcement ?? '', ...row.finish]
			for (const value of values) expect(value).not.toContain(',')
		}
	})

	it.each([
		['ABS-GF', 'ABS', 'GF', 'Standard'],
		['PA6-CF', 'PA6', 'CF', 'Standard'],
		['PLA+', 'PLA', null, 'Plus'],
		['PLA Silk+', 'PLA', null, 'Plus'],
		['PETG High Speed', 'PETG', null, 'High Speed'],
		['PLA Lite', 'PLA', null, 'Lite']
	])('maps %s correctly', (material, polymer, reinforcement, series) => {
		const row = migration.TAXONOMY[material]
		expect(row.polymer).toBe(polymer)
		expect(row.reinforcement).toBe(reinforcement)
		expect(row.series).toBe(series)
	})

	it('treats "Transparent" as a colour, not a finish', () => {
		// TD-0002 §5.2.1: it is meant to be covered by color.family = transparent.
		expect(migration.TAXONOMY['PLA Transparent Rainbow'].finish).toEqual(['Rainbow'])
	})

	it('splits a two-effect material into two finishes', () => {
		expect(migration.TAXONOMY['PLA Matte Rainbow'].finish).toEqual(['Matte', 'Rainbow'])
		expect(migration.TAXONOMY['PLA Silk Rainbow'].finish).toEqual(['Silk', 'Rainbow'])
	})
})

describe('normalizeMaterial', () => {
	it.each([
		['PLA Silk', 'PLA Silk'],
		['  PLA   Silk  ', 'PLA Silk'],
		['PETG Refill', 'PETG'],
		['PETG refill', 'PETG'],
		['PETG  REFILL  ', 'PETG']
	])('normalizes %p to %p', (input, expected) => {
		expect(migration.normalizeMaterial(input)).toBe(expected)
	})

	it.each([[''], ['   '], [null], [undefined], [42]])('returns null for %p', value => {
		expect(migration.normalizeMaterial(value)).toBeNull()
	})

	it('does not strip "Refill" from the middle of a name', () => {
		expect(migration.normalizeMaterial('Refill PLA')).toBe('Refill PLA')
	})
})

describe('lookupTaxonomy', () => {
	it('is case-insensitive', () => {
		expect(migration.lookupTaxonomy('pla silk')?.polymer).toBe('PLA')
	})

	it('resolves a refill to the same row as the spooled material', () => {
		// The packaging is described by spool_included, not by a separate taxonomy row.
		expect(migration.lookupTaxonomy('PETG Refill')).toBe(migration.lookupTaxonomy('PETG'))
	})

	it.each([['Unknown Polymer'], [''], [null]])('returns null for %p', value => {
		expect(migration.lookupTaxonomy(value)).toBeNull()
	})
})

describe('deriveAttributes', () => {
	const base: [string, string, string][] = [
		['vyrobnyk', 'Виробник', 'Kingroon'],
		['material', 'Матеріал', 'PLA Matte Rainbow']
	]

	it('appends the derived entries and keeps material', () => {
		const result = migration.deriveAttributes(attrs(...base))

		expect(result.matched).toBe(true)
		expect(result.attributes).toEqual([
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Kingroon' },
			{ k: 'material', l: 'Матеріал', v: 'PLA Matte Rainbow' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
			{ k: 'finish', l: 'Ефект поверхні', v: 'Matte' },
			{ k: 'finish', l: 'Ефект поверхні', v: 'Rainbow' },
			{ k: 'series', l: 'Серія', v: 'Standard' }
		])
	})

	it('omits reinforcement when the material has none', () => {
		const result = migration.deriveAttributes(attrs(['material', 'Матеріал', 'PLA']))

		expect(result.attributes?.map(a => a.k)).toEqual(['material', 'polymer', 'series'])
	})

	it('rebuilds rather than duplicates, so a second run changes nothing', () => {
		const once = migration.deriveAttributes(attrs(...base))
		const twice = migration.deriveAttributes(once.attributes)

		expect(twice.attributes).toEqual(once.attributes)
	})

	it('re-derives after the mapping changed, dropping the stale values', () => {
		const stale = [
			{ k: 'material', l: 'Матеріал', v: 'PLA' },
			{ k: 'polymer', l: 'Тип пластику', v: 'WRONG' },
			{ k: 'finish', l: 'Ефект поверхні', v: 'Gone' }
		]
		const result = migration.deriveAttributes(stale)

		expect(result.attributes).toEqual([
			{ k: 'material', l: 'Матеріал', v: 'PLA' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
			{ k: 'series', l: 'Серія', v: 'Standard' }
		])
	})

	it('reports an unmatched material instead of guessing', () => {
		const result = migration.deriveAttributes(attrs(['material', 'Матеріал', 'Unobtainium']))

		expect(result.matched).toBe(false)
		expect(result.material).toBe('Unobtainium')
		expect(result.attributes).toBeNull()
	})

	it('reports an empty material as unmatched, with the value it saw', () => {
		const result = migration.deriveAttributes(attrs(['material', 'Матеріал', '']))

		expect(result.matched).toBe(false)
		expect(result.material).toBe('')
	})

	it.each([[undefined], [null], ['attributes']])(
		'passes %p through as unmatched with no material',
		value => {
			const result = migration.deriveAttributes(value)

			expect(result.matched).toBe(false)
			expect(result.material).toBeNull()
		}
	)

	it('does not mutate the input', () => {
		const input = attrs(...base)
		const snapshot = JSON.stringify(input)

		migration.deriveAttributes(input)

		expect(JSON.stringify(input)).toBe(snapshot)
	})
})

describe('rebuildRequiredAttributes (task 17)', () => {
	const required = [
		{ key: 'vyrobnyk', label: 'Виробник', filter_type: 'multi-select', unit: null },
		{ key: 'material', label: 'Матеріал', filter_type: 'multi-select', unit: null }
	]

	it('drops material and adds the four dimensions', () => {
		const result = migration.rebuildRequiredAttributes(required)

		expect(result?.map(a => a.key)).toEqual([
			'vyrobnyk',
			'polymer',
			'finish',
			'reinforcement',
			'series'
		])
	})

	it('gives the new attributes the labels the override table keys off', () => {
		const result = migration.rebuildRequiredAttributes(required)
		const labels = Object.fromEntries(result!.map(a => [a.key, a.label]))

		expect(labels).toMatchObject(migration.KEYS)
	})

	it('leaves a category that never required material alone', () => {
		expect(migration.rebuildRequiredAttributes([required[0]])).toBeNull()
	})

	it('does not duplicate a dimension that is already listed', () => {
		const partial = [
			...required,
			{ key: 'polymer', label: 'Тип пластику', filter_type: 'multi-select', unit: null }
		]
		const result = migration.rebuildRequiredAttributes(partial)

		expect(result?.filter(a => a.key === 'polymer')).toHaveLength(1)
	})

	it.each([[undefined], [null], ['x']])('returns null for %p', value => {
		expect(migration.rebuildRequiredAttributes(value)).toBeNull()
	})
})
