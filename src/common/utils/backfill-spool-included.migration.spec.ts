/**
 * The symmetry rule is the whole point of this migration: `$elemMatch` cannot test for the
 * absence of an attribute, so unless every product carries `spool_included`, the filter has a
 * single selectable value and "show me only spooled filament" becomes inexpressible
 * (TD-0002 §5.2.1).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../scripts/fillando_v_2/backfill-spool-included.js') as {
	KEY: string
	LABEL: string
	DEFAULT_VALUE: string
	REFILL_VALUE: string
	isRefillVariant: (variant: unknown) => boolean
	withSpoolIncluded: (attributes: unknown) => {
		attributes: { k: string; l: string; v: string }[] | null
		changed: boolean
	}
	withSpoolFilter: (required: unknown) => {
		required_attributes: { key: string; label: string }[] | null
		changed: boolean
	}
}

const ATTR = { k: 'polymer', l: 'Тип пластику', v: 'PLA' }

describe('spool_included constants', () => {
	it('uses the key the override table pins and the label the admin sees', () => {
		expect(migration.KEY).toBe('spool_included')
		expect(migration.LABEL).toBe('Котушка в комплекті')
	})

	it.each([['DEFAULT_VALUE'], ['REFILL_VALUE']] as const)(
		'%s contains no comma, which the catalogue query splits on',
		field => {
			expect(migration[field]).not.toContain(',')
		}
	)

	it('has exactly the two values the design allows', () => {
		expect(migration.DEFAULT_VALUE).toBe('Так')
		expect(migration.REFILL_VALUE).toBe('Ні (рефіл)')
	})
})

describe('withSpoolIncluded', () => {
	it('appends the attribute to a product that lacks it', () => {
		const result = migration.withSpoolIncluded([ATTR])

		expect(result.changed).toBe(true)
		expect(result.attributes).toEqual([
			ATTR,
			{ k: 'spool_included', l: 'Котушка в комплекті', v: 'Так' }
		])
	})

	it('never overwrites a refill already marked by hand', () => {
		const refill = [ATTR, { k: 'spool_included', l: 'Котушка в комплекті', v: 'Ні (рефіл)' }]
		const result = migration.withSpoolIncluded(refill)

		expect(result.changed).toBe(false)
		expect(result.attributes).toBe(refill)
	})

	it('is idempotent', () => {
		const once = migration.withSpoolIncluded([ATTR])
		const twice = migration.withSpoolIncluded(once.attributes)

		expect(twice.changed).toBe(false)
		expect(twice.attributes).toEqual(once.attributes)
	})

	it('does not mutate the input array', () => {
		const input = [ATTR]
		migration.withSpoolIncluded(input)

		expect(input).toEqual([ATTR])
	})

	it('backfills a product with no attributes at all', () => {
		const result = migration.withSpoolIncluded([])

		expect(result.changed).toBe(true)
		expect(result.attributes).toHaveLength(1)
	})

	it.each([[undefined], [null], ['attributes']])('leaves %p alone', value => {
		const result = migration.withSpoolIncluded(value)

		expect(result.changed).toBe(false)
		expect(result.attributes).toBeNull()
	})
})

describe('withSpoolFilter', () => {
	const required = [
		{ key: 'polymer', label: 'Тип пластику', filter_type: 'multi-select', unit: null }
	]

	it('offers the filter as a multi-select with no unit', () => {
		const result = migration.withSpoolFilter(required)

		expect(result.changed).toBe(true)
		expect(result.required_attributes?.at(-1)).toEqual({
			key: 'spool_included',
			label: 'Котушка в комплекті',
			filter_type: 'multi-select',
			unit: null
		})
	})

	it('does not add it twice', () => {
		const once = migration.withSpoolFilter(required)
		const twice = migration.withSpoolFilter(once.required_attributes)

		expect(twice.changed).toBe(false)
	})

	it.each([[undefined], [null]])('leaves %p alone', value => {
		expect(migration.withSpoolFilter(value).changed).toBe(false)
	})
})

describe('isRefillVariant', () => {
	/**
	 * `spool_included` is a product attribute, so it can only describe a product whose variants
	 * agree about the packaging. In this database FL-000253 is a refill sitting next to eight
	 * spooled colours on one product — TD-0002 §5.2.1 assumed the refill would be its own
	 * product — so the migration has to recognise and skip it rather than assert "Так".
	 */
	it.each([
		['the marker inside a colour value', { v_value: 'Clear Безбарвний Refill' }],
		['a lower-case marker', { v_value: 'clear refill' }],
		['the Ukrainian word', { v_value: 'Безбарвний рефіл' }],
		['the marker in the variant name', { name: 'PETG Translucent Refill', v_value: 'Clear' }]
	])('recognises %s', (_case, variant) => {
		expect(migration.isRefillVariant(variant)).toBe(true)
	})

	it.each([
		['an ordinary colour', { v_value: 'Clear Безбарвний' }],
		['a colour that merely contains the letters', { v_value: 'Refilled Blue Refillable' }],
		['no colour at all', { v_value: null, name: 'PLA Basic' }],
		['an empty variant', {}]
	])('does not flag %s', (_case, variant) => {
		expect(migration.isRefillVariant(variant)).toBe(false)
	})
})
