// The colour dictionary is only useful if it actually recognises what is stored in the
// catalogue. These are the exact spellings a production dump held on 2026-09-05 that the
// dictionary could not match; each one now has an entry, and this spec is what stops a future
// edit to `seed-colors.js` from quietly dropping one again. The catalogue is frozen while the
// TD-0002 work lands, so this list is closed rather than a sample.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const seedColors = require('../../../scripts/fillando_v_2/seed-colors.js') as {
	COLORS: Color[]
	normalizeColorValue: (value: string) => string | null
	aliasesFor: (color: Color) => string[]
	/** Maps a lower-cased alias to the owning colour's `name_en`. */
	buildAliasIndex: (colors: Color[]) => Map<string, string>
	slugFor: (nameEn: string) => string
}

type Color = {
	name_en: string
	name_uk: string
	family: string
	hex_stops: string[]
	synonyms?: string[]
}

const { COLORS, normalizeColorValue, aliasesFor, buildAliasIndex, slugFor } = seedColors

const FAMILIES = [
	'black', 'white', 'gray', 'red', 'orange', 'yellow', 'green', 'blue',
	'purple', 'pink', 'brown', 'gold', 'silver', 'transparent', 'multicolor'
]

/** Grouped by the product each spelling came from — the grouping is what makes slugs collide. */
const STORED_VALUES: Record<string, string[]> = {
	'Kingroon PLA Dual-Silk': [
		'Червоно-золотистий', 'Червоно-зелений', 'Червоно-синій', 'Золотисто-срібний',
		'Золотисто-фіолетовий', 'Чорно-золотистий', 'Чорно-червоний', 'Чорно-зелений', 'HC186'
	],
	'Kingroon PLA Tri-Silk': [
		'Червоно-жовто-синій', 'Червоно-зелено-синій', 'Жовто-синьо-зелений',
		'Золотисто-зелено-рожевий', 'Золотисто-срібно-мідний', 'Зелено-фіолетово-мідний',
		'Червоно-золотисто-синій', 'Чорно-синьо-фіолетовий', 'Червоно-золотисто-фіолетовий',
		'Синьо-зелено-помаранчевий', 'Золотисто-пурпурово-чорний', 'Золотисто-пурпурово-синій',
		'Золотисто-зелено-чорний', 'Пурпурово-синьо-зелений'
	],
	'Kingroon PLA Silk Rainbow': ['Universe', 'Macaron', 'Forest', 'Lovely'],
	'Kingroon PETG (CoPET)': [
		'Флуоресцентний жовтий', 'Флуоресцентний синій', 'Флуоресцентний червоний'
	],
	'Kingroon PLA Temperature Changing': [
		'Синьо-зелений -Жовто-зелений', 'Фіолетовий-рожевий', 'Синій-білий', 'Сірий-білий'
	],
	'Sunlu PLA Rainbow': ['Веселковий R1', 'Веселковий R2', 'Веселковий R3', 'Веселковий R4'],
	'Sunlu PLA Transparent Rainbow': ['TR-1', 'TR-2', 'TR-3', 'TR-4'],
	'Kingroon PLA': ['Мармур', 'Combustion Titanium'],
	'Sunlu PETG': ['Керамічний'],
	'Sunlu Wood PLA': ['Звичайне'],
	'Bambu Lab TPU для AMS': ['Неоново-зелений'],
	'Bambu Lab PLA Lite': ['Matte Beige Бежевий (матовий)']
}

const ALL_VALUES = Object.values(STORED_VALUES).flat()

/**
 * Deliberately unmatched: two variants of one product are both stored as "Candy". Giving them
 * the same dictionary colour would give them the same variant slug, and `slug` is unique, so
 * the colour migration would abort. Which is which is a question about the photographs.
 */
const KNOWN_UNMATCHED = ['Candy']

describe('colour dictionary coverage', () => {
	const index = buildAliasIndex(COLORS)
	/** @returns the `name_en` the stored spelling resolves to, or null when nothing claims it. */
	const resolve = (value: string): string | null => {
		const normalized = normalizeColorValue(value)
		return normalized ? (index.get(normalized.toLowerCase()) ?? null) : null
	}

	describe('every spelling stored in the catalogue resolves', () => {
		it.each(ALL_VALUES)('resolves %s', value => {
			expect({ value, resolved: resolve(value) }).toEqual({ value, resolved: expect.any(String) })
		})

		// 49 spellings were unmatched on the dump; 48 are covered here and "Candy" is the one left.
		// 47 of them became new dictionary entries and the 48th is a synonym on the existing Beige.
		it('covers all 48 of them', () => {
			expect(ALL_VALUES).toHaveLength(48)
			expect(ALL_VALUES.filter(v => resolve(v) === null)).toEqual([])
		})
	})

	describe('no two variants of one product can collide on a slug', () => {
		// The variant slug is generateSlug(`${product} ${name_en}`), so two values on the same
		// product resolving to one colour would produce one slug twice and abort the migration.
		it.each(Object.entries(STORED_VALUES))('%s gives every variant its own colour', (_product, values) => {
			const names = values.map(v => resolve(v)).filter(Boolean)
			expect(new Set(names).size).toBe(values.length)
		})
	})

	describe('"Candy" stays unmatched on purpose', () => {
		it.each(KNOWN_UNMATCHED)('%s resolves to nothing', value => {
			expect(resolve(value)).toBeNull()
		})
	})

	describe('the dictionary itself stays well formed', () => {
		it('has a unique name_en on every entry', () => {
			const names = COLORS.map(c => c.name_en)
			expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
		})

		it('has a unique slug on every entry', () => {
			const slugs = COLORS.map(c => slugFor(c.name_en))
			expect(slugs.filter((s, i) => slugs.indexOf(s) !== i)).toEqual([])
		})

		it('never lets one alias point at two colours', () => {
			const seen = new Map<string, string>()
			const conflicts: string[] = []
			for (const color of COLORS) {
				for (const alias of aliasesFor(color)) {
					const owner = seen.get(alias)
					if (owner && owner !== color.name_en) conflicts.push(`${alias}: ${owner} / ${color.name_en}`)
					seen.set(alias, color.name_en)
				}
			}
			expect(conflicts).toEqual([])
		})

		it('uses only the fifteen families the schema allows', () => {
			expect(COLORS.filter(c => !FAMILIES.includes(c.family)).map(c => c.name_en)).toEqual([])
		})

		it('gives every entry between one and six lower-case hex stops', () => {
			const bad = COLORS.filter(
				c =>
					!Array.isArray(c.hex_stops) ||
					c.hex_stops.length < 1 ||
					c.hex_stops.length > 6 ||
					c.hex_stops.some(h => !/^#[0-9a-f]{6}$/.test(h))
			)
			expect(bad.map(c => c.name_en)).toEqual([])
		})

		it('does not repeat a stop within one entry, which would flatten the swatch', () => {
			const flat = COLORS.filter(c => c.hex_stops.length > 1 && new Set(c.hex_stops).size === 1)
			expect(flat.map(c => c.name_en)).toEqual([])
		})

		it('has a Ukrainian name on every entry', () => {
			expect(COLORS.filter(c => !c.name_uk || !c.name_uk.trim()).map(c => c.name_en)).toEqual([])
		})

		it('uses no em dash, which the copy style forbids', () => {
			const withDash = COLORS.filter(c => c.name_uk.includes('—') || c.name_en.includes('—'))
			expect(withDash.map(c => c.name_en)).toEqual([])
		})
	})

	describe('the normalizer still strips what the data carries', () => {
		it('drops a trailing Refill marker before matching', () => {
			expect(normalizeColorValue('Clear Безбарвний Refill')).toBe('Clear Безбарвний')
		})

		it('keeps the space before the dash in the thermochromic value', () => {
			// If this ever normalises differently, the synonym stops matching silently.
			expect(normalizeColorValue('Синьо-зелений -Жовто-зелений')).toBe('Синьо-зелений -Жовто-зелений')
		})
	})
})
