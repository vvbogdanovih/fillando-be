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

/** Grouped by the product each spelling came from — the grouping is what makes slugs collide. */
const STORED_VALUES: Record<string, string[]> = {
	'Kingroon PLA Dual-Silk': [
		'Червоно-золотистий',
		'Червоно-зелений',
		'Червоно-синій',
		'Золотисто-срібний',
		'Золотисто-фіолетовий',
		'Чорно-золотистий',
		'Чорно-червоний',
		'Чорно-зелений',
		'HC186'
	],
	'Kingroon PLA Tri-Silk': [
		'Червоно-жовто-синій',
		'Червоно-зелено-синій',
		'Жовто-синьо-зелений',
		'Золотисто-зелено-рожевий',
		'Золотисто-срібно-мідний',
		'Зелено-фіолетово-мідний',
		'Червоно-золотисто-синій',
		'Чорно-синьо-фіолетовий',
		'Червоно-золотисто-фіолетовий',
		'Синьо-зелено-помаранчевий',
		'Золотисто-пурпурово-чорний',
		'Золотисто-пурпурово-синій',
		'Золотисто-зелено-чорний',
		'Пурпурово-синьо-зелений'
	],
	// «Candy» and «Rainbow Candy» are the two Kingroon articles (B01889 / HC258) that step 3a tells
	// apart; the stored value of FL-000162 becomes «Rainbow Candy» before the colour step runs.
	'Kingroon PLA Silk Rainbow': [
		'Universe',
		'Macaron',
		'Forest',
		'Lovely',
		'Candy',
		'Rainbow Candy'
	],
	'Kingroon PETG (CoPET)': [
		'Флуоресцентний жовтий',
		'Флуоресцентний синій',
		'Флуоресцентний червоний'
	],
	'Kingroon PLA Temperature Changing': [
		'Синьо-зелений -Жовто-зелений',
		'Фіолетовий-рожевий',
		'Синій-білий',
		'Сірий-білий'
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

describe('colour dictionary coverage', () => {
	const index = buildAliasIndex(COLORS)
	/** @returns the `name_en` the stored spelling resolves to, or null when nothing claims it. */
	const resolve = (value: string): string | null => {
		const normalized = normalizeColorValue(value)
		return normalized ? (index.get(normalized.toLowerCase()) ?? null) : null
	}

	describe('every spelling stored in the catalogue resolves', () => {
		it.each(ALL_VALUES)('resolves %s', value => {
			expect({ value, resolved: resolve(value) }).toEqual({
				value,
				resolved: expect.any(String)
			})
		})

		// 49 spellings were unmatched on the dump; 48 became entries or synonyms on 2026-09-05 and
		// «Candy» was left for the owner. On 2026-09-07 it became two entries — the two variants
		// were two different Kingroon articles — so every stored spelling now resolves.
		it('covers all 50 of them', () => {
			expect(ALL_VALUES).toHaveLength(50)
			expect(ALL_VALUES.filter(v => resolve(v) === null)).toEqual([])
		})
	})

	describe('no two variants of one product can collide on a slug', () => {
		// The variant slug is generateSlug(`${product} ${name_en}`), so two values on the same
		// product resolving to one colour would produce one slug twice and abort the migration.
		it.each(Object.entries(STORED_VALUES))(
			'%s gives every variant its own colour',
			(_product, values) => {
				const names = values.map(v => resolve(v)).filter(Boolean)
				expect(new Set(names).size).toBe(values.length)
			}
		)
	})

	describe("the Ukrainian names match the suppliers' own English names", () => {
		// Checked on 2026-09-07 against the Kingroon commercial invoices (May and June 2026), the
		// Sunlu proforma (June 2026) and the Sunlu order form. Before this, a synonym folded each of
		// these stored spellings into a colour of a *different* brand — Sunlu «Сонячно-помаранчевий»
		// read «Sunflower», Bambu's name — so the storefront showed one manufacturer's colour name on
		// another manufacturer's spool. The supplier's misspellings resolve too, but only as aliases.
		it.each([
			['Сонячно-помаранчевий', 'Sunny Orange'],
			['Suny Orange', 'Sunny Orange'],
			['Вишнево-червоний', 'Cherry Red'],
			['Вишня', 'Cherry Wood'],
			['Cherry wood', 'Cherry Wood'],
			['Небесно-блакитний', 'Sky Blue'],
			['Sky blue', 'Sky Blue'],
			['Лавандово-фіолетовий', 'Lavender Purple'],
			['Яскраво-жовтий', 'Vivid Yellow'],
			['Каштановий', 'Roasted Chestnut'],
			['Roasted Chesnut', 'Roasted Chestnut'],
			['Опівнічний (темно-синій)', 'Midnight'],
			['Оливково-зелений', 'Olive Green'],
			['М’ятно-зелений', 'Mint Green'],
			['Кавово-коричневий', 'Coffee Brown'],
			['Прозорий', 'Transparent'],
			['Синьо-зелений', 'Blue Green Silk'],
			['Blue-Green', 'Blue Green Silk'],
			['Синьо-фіолетовий', 'Blue Purple Silk'],
			['Бузкво-фіолетовий', 'Lilac Purple'],
			['Трав’яний зелений', 'Grass Green'],
			['Navy Blue Темно-синій', 'Navy Blue'],
			['Golden', 'Gold'],
			['Fluo Red', 'Fluorescent Red'],
			['Fluo Yellow', 'Fluorescent Yellow']
		])('resolves %s to %s', (stored, expected) => {
			expect(resolve(stored)).toBe(expected)
		})

		it('keeps the brands apart: Bambu names are no longer the fallback for Sunlu and Kingroon', () => {
			expect(resolve('Сонячно-помаранчевий')).not.toBe('Sunflower')
			expect(resolve('Вишнево-червоний')).not.toBe('Burgundy Red')
			expect(resolve('Небесно-блакитний')).not.toBe('Cyan')
			expect(resolve('Лавандово-фіолетовий')).not.toBe('Iris Purple')
			// Bambu's colourless PETG stays Clear; Kingroon's is Transparent, as its invoices print.
			expect(resolve('Clear')).toBe('Clear')
			expect(resolve('Безбарвний')).toBe('Clear')
		})

		it('never shows a shopper a supplier misspelling', () => {
			const names = COLORS.flatMap(c => [c.name_en, c.name_uk])
			expect(names.filter(n => /Chesnut|Suny|Бузкво/.test(n))).toEqual([])
		})
	})

	describe('the two Candy variants take different colours', () => {
		it('resolves «Candy» and «Rainbow Candy» to two entries, so their slugs differ', () => {
			expect(resolve('Candy')).toBe('Candy')
			expect(resolve('Rainbow Candy')).toBe('Rainbow Candy')
			expect(resolve('Rainbow')).toBe('Rainbow')
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
					if (owner && owner !== color.name_en)
						conflicts.push(`${alias}: ${owner} / ${color.name_en}`)
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
			const flat = COLORS.filter(
				c => c.hex_stops.length > 1 && new Set(c.hex_stops).size === 1
			)
			expect(flat.map(c => c.name_en)).toEqual([])
		})

		it('has a Ukrainian name on every entry', () => {
			expect(COLORS.filter(c => !c.name_uk || !c.name_uk.trim()).map(c => c.name_en)).toEqual(
				[]
			)
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
			expect(normalizeColorValue('Синьо-зелений -Жовто-зелений')).toBe(
				'Синьо-зелений -Жовто-зелений'
			)
		})
	})
})
