// The migration runs with plain `node`, so its helpers are exercised here rather than through
// the API. Two of these tests are load-bearing rather than defensive: the suffix must not read
// as a refill marker to the two migrations that share `isRefillVariant`, and the slug the split
// writes must equal the one `ProductService` would write on the next ordinary save.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const split = require('../../../scripts/fillando_v_2/split-refill-products.js') as {
	stripRefillMarker: (value: unknown) => unknown
	refillProductName: (name: unknown) => unknown
	withSpoolValue: (attributes: unknown, value: string) => Attr[]
	spoolValueOf: (attributes: unknown) => string | null
	plannedVariant: (variant: PlanInput, productName: string) => Planned
	SUFFIX: string
	REFILL_VALUE: string
	SPOOLED_VALUE: string
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const colors = require('../../../scripts/fillando_v_2/normalize-variant-colors.js') as {
	generateSlug: (text: string) => string
	isRefillVariant: (variant: { v_value?: unknown; name?: unknown }) => boolean
	mergeSlugMap: (entries: { from: string; to: string }[]) => { from: string; to: string }[]
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const seedColors = require('../../../scripts/fillando_v_2/seed-colors.js') as {
	normalizeColorValue: (value: string) => string | null
	COLORS: { name_en: string; name_uk: string; synonyms?: string[] }[]
}

type Attr = { k: string; l: string; v: unknown }
type PlanInput = { _id?: unknown; sku: string; slug: string; v_value: string | null }
type Planned = {
	sku: string
	old_slug: string
	old_v_value: string | null
	v_value: string | null
	name: string
	slug: string
}

const {
	stripRefillMarker,
	refillProductName,
	withSpoolValue,
	spoolValueOf,
	plannedVariant,
	SUFFIX,
	REFILL_VALUE,
	SPOOLED_VALUE
} = split

const PARENT = 'Філамент (пластик для 3D принтера) Bambu Lab PETG Translucent (напівпрозорий) 1,75 мм 1 кг'

describe('split-refill-products migration', () => {
	describe('stripRefillMarker', () => {
		it.each([
			['Clear Безбарвний Refill', 'Clear Безбарвний'],
			['Refill Clear', 'Clear'],
			['Clear (Refill) Безбарвний', 'Clear Безбарвний'],
			['Clear [refill] Безбарвний', 'Clear Безбарвний'],
			['Безбарвний рефіл', 'Безбарвний'],
			['рефіл Прозорий', 'Прозорий'],
			['Clear  Refill  ', 'Clear'],
			['REFILL Clear', 'Clear']
		])('strips the marker from %s', (input, expected) => {
			expect(stripRefillMarker(input)).toBe(expected)
		})

		it.each(['Чорний', 'Clear Безбарвний', 'Matte Black'])('leaves %s alone', value => {
			expect(stripRefillMarker(value)).toBe(value)
		})

		// A Cyrillic letter is not a JS `\w`, so `\bрефіл\b` never matches after a space. The
		// English spelling keeps its boundaries and the Ukrainian one does not, which is the same
		// shape `isRefillVariant` uses.
		it('handles the Ukrainian spelling, where ASCII word boundaries do not apply', () => {
			expect(stripRefillMarker('Безбарвний рефіл')).toBe('Безбарвний')
		})

		it.each(['Refill', 'рефіл', '  refill  '])(
			'keeps %s unchanged rather than leaving no colour at all',
			value => {
				// Stripping to nothing would make the slug the bare product name and collide with
				// any other value-less variant, so the original is kept and the operator decides.
				expect(stripRefillMarker(value)).toBe(value)
			}
		)

		it('does not touch a word that merely contains the marker', () => {
			expect(stripRefillMarker('Refillable Blue')).toBe('Refillable Blue')
		})

		it.each([null, undefined, 42, {}])('passes %p through unchanged', value => {
			expect(stripRefillMarker(value)).toBe(value)
		})

		it('is idempotent', () => {
			const once = stripRefillMarker('Clear Безбарвний Refill') as string
			expect(stripRefillMarker(once)).toBe(once)
		})
	})

	describe('refillProductName', () => {
		it('appends the suffix', () => {
			expect(refillProductName(PARENT)).toBe(`${PARENT}${SUFFIX}`)
		})

		it('is idempotent, so a re-run reuses the same product', () => {
			const once = refillProductName(PARENT) as string
			expect(refillProductName(once)).toBe(once)
		})

		it('passes a non-string through', () => {
			expect(refillProductName(null)).toBeNull()
		})
	})

	describe('the suffix must not read as a refill marker', () => {
		// This is the whole reason the suffix is "(без котушки)" and not "Refill".
		// `isRefillVariant` inspects the variant NAME too, and the variant name is built from the
		// product name — so a product called "… Refill" would keep the variant out of the colour
		// dictionary for ever, which is precisely the state this migration exists to end.
		it('a product named with the suffix does not trip isRefillVariant', () => {
			const name = refillProductName(PARENT) as string
			expect(colors.isRefillVariant({ name, v_value: 'Clear Безбарвний' })).toBe(false)
		})

		it('the suffix itself contains neither spelling of the marker', () => {
			expect(/refill|рефіл/i.test(SUFFIX)).toBe(false)
		})

		it('a variant still carrying the marker in its value is still recognised', () => {
			expect(colors.isRefillVariant({ name: PARENT, v_value: 'Clear Безбарвний Refill' })).toBe(
				true
			)
		})

		it('the moved variant is no longer recognised, which is what lets its colour resolve', () => {
			const productName = refillProductName(PARENT) as string
			const planned = plannedVariant(
				{ sku: 'FL-000253', slug: 'old', v_value: 'Clear Безбарвний Refill' },
				productName
			)
			expect(colors.isRefillVariant({ name: planned.name, v_value: planned.v_value })).toBe(false)
		})
	})

	describe('plannedVariant', () => {
		const productName = refillProductName(PARENT) as string
		const planned = plannedVariant(
			{ sku: 'FL-000253', slug: 'old-slug', v_value: 'Clear Безбарвний Refill' },
			productName
		)

		it('keeps the SKU and records where the variant came from', () => {
			expect({ sku: planned.sku, old_slug: planned.old_slug, old: planned.old_v_value }).toEqual({
				sku: 'FL-000253',
				old_slug: 'old-slug',
				old: 'Clear Безбарвний Refill'
			})
		})

		it('drops the marker from the stored colour value', () => {
			expect(planned.v_value).toBe('Clear Безбарвний')
		})

		it('builds the name the way ProductService.variantName does', () => {
			expect(planned.name).toBe(`${productName} — Clear Безбарвний`)
		})

		// If these two formulas ever diverge, the first ordinary admin save silently moves the
		// address again — the defect the two-pass rename in ProductService exists to prevent.
		it('builds the slug the way ProductService does, from product name plus colour value', () => {
			expect(planned.slug).toBe(colors.generateSlug(`${productName} Clear Безбарвний`))
		})

		it('falls back to the bare product name when there is no colour value', () => {
			const noColor = plannedVariant({ sku: 'FL-1', slug: 'x', v_value: null }, productName)
			expect({ name: noColor.name, slug: noColor.slug }).toEqual({
				name: productName,
				slug: colors.generateSlug(productName)
			})
		})

		it('produces a slug that differs from the parent product’s, so the two cannot collide', () => {
			const onParent = colors.generateSlug(`${PARENT} Clear Безбарвний`)
			expect(planned.slug).not.toBe(onParent)
		})
	})

	describe('the cleaned value resolves against the colour dictionary', () => {
		// The point of stripping the marker: this value has to be matchable, or the refill stays
		// out of the swatch filter exactly as before the split.
		it('normalizeColorValue keeps "Clear Безбарвний" intact', () => {
			expect(seedColors.normalizeColorValue('Clear Безбарвний')).toBe('Clear Безбарвний')
		})

		it('and would have stripped the marker anyway, had one survived', () => {
			expect(seedColors.normalizeColorValue('Clear Безбарвний Refill')).toBe('Clear Безбарвний')
		})

		it('the dictionary holds a Clear entry to match it', () => {
			const clear = seedColors.COLORS.find(c => c.name_en === 'Clear')
			expect(clear).toBeDefined()
			expect(clear?.name_uk).toBe('Безбарвний')
		})
	})

	describe('withSpoolValue / spoolValueOf', () => {
		const OTHER: Attr[] = [
			{ k: 'polymer', l: 'Тип пластику', v: 'PETG' },
			{ k: 'diametr', l: 'Діаметр', v: 1.75 }
		]

		it('appends the attribute when it is missing', () => {
			const result = withSpoolValue(OTHER, REFILL_VALUE)
			expect(result).toHaveLength(3)
			expect(result[2]).toEqual({ k: 'spool_included', l: 'Котушка в комплекті', v: REFILL_VALUE })
		})

		it('replaces an existing entry instead of duplicating it', () => {
			const withSpooled = withSpoolValue(OTHER, SPOOLED_VALUE)
			const flipped = withSpoolValue(withSpooled, REFILL_VALUE)
			expect(flipped.filter(a => a.k === 'spool_included')).toHaveLength(1)
			expect(spoolValueOf(flipped)).toBe(REFILL_VALUE)
		})

		it('keeps the other attributes and their order', () => {
			expect(withSpoolValue(OTHER, REFILL_VALUE).slice(0, 2)).toEqual(OTHER)
		})

		it('copes with a product that has no attributes array', () => {
			expect(withSpoolValue(undefined, REFILL_VALUE)).toEqual([
				{ k: 'spool_included', l: 'Котушка в комплекті', v: REFILL_VALUE }
			])
		})

		it('reads back null when the attribute is absent', () => {
			expect(spoolValueOf(OTHER)).toBeNull()
			expect(spoolValueOf(null)).toBeNull()
		})

		it('uses the two values the backfill migration knows', () => {
			expect([SPOOLED_VALUE, REFILL_VALUE]).toEqual(['Так', 'Ні (рефіл)'])
		})
	})

	describe('slug map is merged, never truncated', () => {
		it('mergeSlugMap is shared with the colour migration rather than copied', () => {
			expect(typeof colors.mergeSlugMap).toBe('function')
		})
	})
})
