import { ATTR_KEY_OVERRIDES, generateAttrKey, normalizeAttrLabel } from './attribute.utils'

/**
 * The unit is what makes the «Вага філаменту» row of the mock exist at all: the products store a
 * bare `1`, the unit lives on the category, and the storefront drops the row rather than print
 * «Вага | 1» (Plan-0005 I-27). The label rename is the risky half — the label is the source of
 * the attribute key — so most of this suite is about the guard that keeps the key where it is.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../scripts/fillando_v_2/backfill-attribute-units.js') as {
	UNITS: Record<string, { unit: string; max_value?: number }>
	NEW_LABEL: string
	OLD_LABEL: string
	PINNED_KEY: string | null
	CATEGORY_FIELDS: Fields
	PRODUCT_FIELDS: Fields
	unitFor: (label: unknown) => { unit: string; max_value?: number } | null
	bareNumbers: (value: unknown) => number[] | null
	rejectUnit: (wanted: { unit: string; max_value?: number }, values: unknown[]) => string | null
	planCategoryUnits: <T>(required: T, valuesByKey?: Record<string, unknown[]>) => UnitPlan<T>
	renameWeightLabel: <T>(entries: T, fields: Fields, pinnedKey: string | null) => RenamePlan<T>
	planCategory: <T>(
		required: T,
		valuesByKey?: Record<string, unknown[]>
	) => UnitPlan<T> & Omit<RenamePlan<T>, 'entries' | 'changed'>
	valuesByCategory: (
		docs: { category_id: unknown; attributes?: unknown }[]
	) => Map<string, Map<string, Map<string, unknown>>>
	toValuesByKey: (
		byKey: Map<string, Map<string, unknown>> | undefined
	) => Record<string, unknown[]>
}

type Fields = { keyField: string; labelField: string }
type Filled = { key: string; label: string; unit: string; values_seen: number }
type Skipped = { key: string; label: string; reason: string }
type Rename = { key: unknown; from: string; to: string }
type UnitPlan<T> = {
	required_attributes: T
	filled: Filled[]
	skipped: Skipped[]
	already: { key: string; label: string; unit: string }[]
	changed: boolean
}
type RenamePlan<T> = { entries: T; renames: Rename[]; blocked: Skipped[]; changed: boolean }

const { NEW_LABEL, OLD_LABEL, CATEGORY_FIELDS, PRODUCT_FIELDS } = migration

type Required = { key: string; label: string; filter_type: string; unit: string | null }

const required = (key: string, label: string, unit: string | null = null): Required => ({
	key,
	label,
	filter_type: 'multi-select',
	unit
})

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('the label rename can never move the attribute key', () => {
	/**
	 * `PINNED_KEY` is the only key the step will rename onto, and the whole guard rests on it.
	 * Both expectations below hold before AND after the override entry lands, so this suite does
	 * not have to be rewritten when it does — which is exactly the property that makes it a
	 * guard rather than a snapshot.
	 */
	it('renames onto the key «Вага» already produces, or onto nothing', () => {
		expect([null, generateAttrKey(OLD_LABEL)]).toContain(migration.PINNED_KEY)
	})

	it('refuses the rename precisely while the new label would produce a different key', () => {
		// Today `generateAttrKey('Вага філаменту')` is `vaha_filamentu` and «Вага» is `vaha`, so
		// the step must refuse. Add `'вага філаменту': 'vaha'` to ATTR_KEY_OVERRIDES and both
		// sides flip together.
		const wouldMoveTheKey = generateAttrKey(NEW_LABEL) !== generateAttrKey(OLD_LABEL)
		expect(migration.PINNED_KEY === null).toBe(wouldMoveTheKey)
	})

	it('reads the pinned key from the deployed override table, not from a local copy', () => {
		const fromTable = ATTR_KEY_OVERRIDES[normalizeAttrLabel(NEW_LABEL)] ?? null
		expect(migration.PINNED_KEY).toBe(fromTable)
	})

	it('renames to the label the mock spells', () => {
		expect(NEW_LABEL).toBe('Вага філаменту')
		expect(OLD_LABEL).toBe('Вага')
	})
})

describe('UNITS dictionary', () => {
	it.each([
		['Вага', 'кг'],
		['Вага філаменту', 'кг'],
		['Діаметр', 'мм'],
		['Температура друку', '°C']
	])('%s → %s', (label, unit) => {
		expect(migration.unitFor(label)?.unit).toBe(unit)
	})

	it('knows both spellings of the weight label, so a second run is a no-op', () => {
		expect(migration.unitFor(OLD_LABEL)?.unit).toBe(migration.unitFor(NEW_LABEL)?.unit)
	})

	it.each([
		['leading and trailing spaces', '  Вага  '],
		['a non-breaking space', 'Температура друку'],
		['upper case', 'ДІАМЕТР'],
		['several inner spaces', 'Температура   друку']
	])('reaches the entry despite %s', (_case, label) => {
		expect(migration.unitFor(label)).not.toBeNull()
	})

	it.each([['Виробник'], ['Матеріал'], ['Колір'], ['Тип пластику'], ['Котушка в комплекті']])(
		'refuses to guess a unit for %s',
		label => {
			expect(migration.unitFor(label)).toBeNull()
		}
	)

	it.each([[undefined], [null], [42]])('leaves %p alone', value => {
		expect(migration.unitFor(value)).toBeNull()
	})

	it('stores every label already in normalized form', () => {
		for (const label of Object.keys(migration.UNITS)) {
			expect(normalizeAttrLabel(label)).toBe(label)
		}
	})

	it('gives every entry a non-empty unit', () => {
		for (const entry of Object.values(migration.UNITS)) {
			expect(entry.unit.trim()).not.toBe('')
		}
	})
})

describe('bareNumbers', () => {
	it.each([
		['an integer', 1, [1]],
		['a numeric string', '1', [1]],
		['a decimal comma', '1,75', [1.75]],
		['a decimal point', '1.75', [1.75]],
		['an en-dash range', '190–220', [190, 220]],
		['a hyphen range', '50-60', [50, 60]],
		['a spaced range', '190 – 220', [190, 220]]
	])('reads %s', (_case, value, expected) => {
		expect(migration.bareNumbers(value)).toEqual(expected)
	})

	it.each([
		['a value that already spells its unit', '1,75 мм'],
		['a temperature that already spells its unit', '190–220 °C'],
		['a word', 'PLA'],
		['an empty string', ''],
		['a boolean', true],
		['null', null],
		['undefined', undefined]
	])('rejects %s', (_case, value) => {
		expect(migration.bareNumbers(value)).toBeNull()
	})
})

describe('planCategoryUnits', () => {
	it('gives «Вага» its unit, so the row stops being dropped', () => {
		const input = [required('vaha', 'Вага'), required('polymer', 'Тип пластику')]
		const result = migration.planCategoryUnits(input, { vaha: [1, 3] })

		expect(result.changed).toBe(true)
		expect(result.required_attributes[0]).toEqual(required('vaha', 'Вага', 'кг'))
		expect(result.filled).toEqual([{ key: 'vaha', label: 'Вага', unit: 'кг', values_seen: 2 }])
	})

	it('changes nothing but `unit`', () => {
		const input = [required('vaha', 'Вага')]
		const result = migration.planCategoryUnits(input, { vaha: [1] })

		expect(Object.keys(result.required_attributes[0])).toEqual(Object.keys(input[0]))
		expect(result.required_attributes[0].label).toBe('Вага')
		expect(result.required_attributes[0].key).toBe('vaha')
		expect(result.required_attributes[0].filter_type).toBe('multi-select')
	})

	it('never overwrites a unit an admin has already typed', () => {
		const input = [required('vaha', 'Вага', 'г')]
		const result = migration.planCategoryUnits(input, { vaha: [1000] })

		expect(result.changed).toBe(false)
		expect(result.already).toEqual([{ key: 'vaha', label: 'Вага', unit: 'г' }])
	})

	it('treats a blank unit as no unit', () => {
		const result = migration.planCategoryUnits([required('vaha', 'Вага', '  ')], { vaha: [1] })

		expect(result.changed).toBe(true)
		expect(result.required_attributes[0].unit).toBe('кг')
	})

	it('lists an attribute whose unit it must not guess, instead of inventing one', () => {
		const result = migration.planCategoryUnits([required('vyrobnyk', 'Виробник')], {})

		expect(result.changed).toBe(false)
		expect(result.skipped).toEqual([
			{
				key: 'vyrobnyk',
				label: 'Виробник',
				reason: 'no unit in the dictionary for this label'
			}
		])
	})

	it('refuses «мм» when the stored value already spells it', () => {
		// The storefront prints `value + unit`, so this would render «1,75 мм мм».
		const result = migration.planCategoryUnits([required('diametr', 'Діаметр')], {
			diametr: ['1,75 мм']
		})

		expect(result.changed).toBe(false)
		expect(result.skipped[0].reason).toContain('already spells its unit')
	})

	it('refuses «кг» when a value is stored in grams', () => {
		const result = migration.planCategoryUnits([required('vaha', 'Вага')], { vaha: [1000] })

		expect(result.changed).toBe(false)
		expect(result.skipped[0].reason).toContain('above 20')
	})

	it('refuses «кг» when only one of several values breaks the bound', () => {
		const result = migration.planCategoryUnits([required('vaha', 'Вага')], { vaha: [1, 500] })

		expect(result.changed).toBe(false)
	})

	it('fills a dimension no product carries yet — nothing can be printed twice', () => {
		const result = migration.planCategoryUnits([required('diametr', 'Діаметр')], {})

		expect(result.changed).toBe(true)
		expect(result.filled).toEqual([
			{ key: 'diametr', label: 'Діаметр', unit: 'мм', values_seen: 0 }
		])
	})

	it('gives a temperature range its unit', () => {
		const result = migration.planCategoryUnits(
			[required('temperatura_druku', 'Температура друку')],
			{ temperatura_druku: ['190–220'] }
		)

		expect(result.required_attributes[0].unit).toBe('°C')
	})

	it('is idempotent', () => {
		const once = migration.planCategoryUnits([required('vaha', 'Вага')], { vaha: [1] })
		const twice = migration.planCategoryUnits(once.required_attributes, { vaha: [1] })

		expect(twice.changed).toBe(false)
		expect(twice.required_attributes).toEqual(once.required_attributes)
	})

	it('does not mutate the input array', () => {
		const input = [required('vaha', 'Вага')]
		const before = clone(input)
		migration.planCategoryUnits(input, { vaha: [1] })

		expect(input).toEqual(before)
	})

	it.each([[undefined], [null], ['required_attributes']])('leaves %p alone', value => {
		const result = migration.planCategoryUnits(value)

		expect(result.changed).toBe(false)
		expect(result.required_attributes).toBe(value)
	})

	it('ignores an entry with no usable label', () => {
		const result = migration.planCategoryUnits([{ key: 'vaha', label: 42 }, null], {})

		expect(result.changed).toBe(false)
		expect(result.skipped).toEqual([])
	})
})

describe('rejectUnit', () => {
	it('accepts values that carry no unit of their own', () => {
		expect(migration.rejectUnit({ unit: 'кг', max_value: 20 }, [1, '3'])).toBeNull()
	})

	it('names the offending value, so the report can be acted on', () => {
		const reason = migration.rejectUnit({ unit: 'мм' }, ['1,75 мм'])

		expect(reason).toContain('1,75 мм')
		expect(reason).toContain('мм')
	})
})

describe('renameWeightLabel — the key guard', () => {
	const categoryEntries = () => [
		required('vaha', 'Вага', 'кг'),
		required('polymer', 'Тип пластику')
	]
	const productEntries = () => [
		{ k: 'vaha', l: 'Вага', v: 1 },
		{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }
	]

	describe('with no override entry (the state of the deployed table today)', () => {
		it('renames nothing on a category', () => {
			const result = migration.renameWeightLabel(categoryEntries(), CATEGORY_FIELDS, null)

			expect(result.changed).toBe(false)
			expect(result.renames).toEqual([])
			expect(result.entries).toEqual(categoryEntries())
		})

		it('renames nothing on a product', () => {
			const result = migration.renameWeightLabel(productEntries(), PRODUCT_FIELDS, null)

			expect(result.changed).toBe(false)
			expect(result.entries).toEqual(productEntries())
		})

		it('reports the entry with the table to change and why', () => {
			const result = migration.renameWeightLabel(productEntries(), PRODUCT_FIELDS, null)

			expect(result.blocked).toHaveLength(1)
			expect(result.blocked[0].key).toBe('vaha')
			expect(result.blocked[0].reason).toContain('ATTR_KEY_OVERRIDES')
			expect(result.blocked[0].reason).toContain('вага філаменту')
			expect(result.blocked[0].reason).toContain('vaha_filamentu')
		})
	})

	describe('with the override entry deployed', () => {
		it('rewrites the label and leaves the key exactly as it was', () => {
			const result = migration.renameWeightLabel(categoryEntries(), CATEGORY_FIELDS, 'vaha')

			expect(result.changed).toBe(true)
			expect(result.entries[0]).toEqual(required('vaha', 'Вага філаменту', 'кг'))
			expect(result.blocked).toEqual([])
			expect(result.renames).toEqual([{ key: 'vaha', from: 'Вага', to: 'Вага філаменту' }])
		})

		it('rewrites the product label and leaves key and value alone', () => {
			const result = migration.renameWeightLabel(productEntries(), PRODUCT_FIELDS, 'vaha')

			expect(result.entries[0]).toEqual({ k: 'vaha', l: 'Вага філаменту', v: 1 })
			expect(result.entries[1]).toEqual({ k: 'polymer', l: 'Тип пластику', v: 'PLA' })
		})

		it('refuses an entry whose key is not the pinned one', () => {
			// A key already moved by an admin save: renaming the label here would cement it.
			const entries = [required('vaha_filamentu', 'Вага')]
			const result = migration.renameWeightLabel(entries, CATEGORY_FIELDS, 'vaha')

			expect(result.changed).toBe(false)
			expect(result.blocked[0].reason).toContain('would move the key')
		})

		it('is idempotent — an entry already renamed is left alone', () => {
			const once = migration.renameWeightLabel(categoryEntries(), CATEGORY_FIELDS, 'vaha')
			const twice = migration.renameWeightLabel(once.entries, CATEGORY_FIELDS, 'vaha')

			expect(twice.changed).toBe(false)
			expect(twice.blocked).toEqual([])
			expect(twice.entries).toEqual(once.entries)
		})

		it('reaches the entry despite a folded label spelling', () => {
			const result = migration.renameWeightLabel(
				[required('vaha', '  ВАГА ')],
				CATEGORY_FIELDS,
				'vaha'
			)

			expect(result.entries[0].label).toBe('Вага філаменту')
		})

		it('does not touch any other label', () => {
			const entries = [required('vyrobnyk', 'Виробник'), required('vaha_netto', 'Вага нетто')]
			const result = migration.renameWeightLabel(entries, CATEGORY_FIELDS, 'vaha')

			expect(result.changed).toBe(false)
			expect(result.blocked).toEqual([])
			expect(result.entries).toEqual(entries)
		})

		it('does not mutate the input array', () => {
			const input = productEntries()
			const before = clone(input)
			migration.renameWeightLabel(input, PRODUCT_FIELDS, 'vaha')

			expect(input).toEqual(before)
		})
	})

	it.each([[undefined], [null], ['attributes']])('leaves %p alone', value => {
		const result = migration.renameWeightLabel(value, PRODUCT_FIELDS, 'vaha')

		expect(result.changed).toBe(false)
		expect(result.entries).toBe(value)
	})

	it('ignores an entry whose label is not a string', () => {
		const result = migration.renameWeightLabel(
			[{ key: 'vaha', label: 42 }],
			CATEGORY_FIELDS,
			'vaha'
		)

		expect(result.changed).toBe(false)
		expect(result.blocked).toEqual([])
	})
})

describe('planCategory', () => {
	it('fills the unit whether or not the rename is allowed', () => {
		const result = migration.planCategory([required('vaha', 'Вага')], { vaha: [1, 3] })

		expect(result.changed).toBe(true)
		expect(result.required_attributes[0].unit).toBe('кг')
	})

	it('keeps recognising the attribute after the rename, so a re-run plans nothing', () => {
		const renamed = [required('vaha', 'Вага філаменту', 'кг')]
		const result = migration.planCategory(renamed, { vaha: [1] })

		expect(result.changed).toBe(false)
		expect(result.skipped).toEqual([])
	})
})

describe('valuesByCategory', () => {
	const docs = [
		{ category_id: 'cat-1', attributes: [{ k: 'vaha', l: 'Вага', v: 1 }] },
		{ category_id: 'cat-1', attributes: [{ k: 'vaha', l: 'Вага', v: '1' }] },
		{ category_id: 'cat-1', attributes: [{ k: 'vaha', l: 'Вага', v: 3 }] },
		{ category_id: 'cat-2', attributes: [{ k: 'diametr', l: 'Діаметр', v: '1,75 мм' }] }
	]

	it('keeps each category to its own values — the unit belongs to one category', () => {
		const byCategory = migration.valuesByCategory(docs)

		expect(migration.toValuesByKey(byCategory.get('cat-1'))).toEqual({ vaha: [1, 3] })
		expect(migration.toValuesByKey(byCategory.get('cat-2'))).toEqual({
			diametr: ['1,75 мм']
		})
	})

	it('counts `1` and "1" once, so the report does not list the same value twice', () => {
		const byCategory = migration.valuesByCategory(docs)

		expect(migration.toValuesByKey(byCategory.get('cat-1')).vaha).toHaveLength(2)
	})

	it('survives a product with no attributes and an unusable entry', () => {
		const byCategory = migration.valuesByCategory([
			{ category_id: 'cat-1' },
			{ category_id: 'cat-1', attributes: [null, { l: 'Вага', v: 1 }] }
		])

		expect(migration.toValuesByKey(byCategory.get('cat-1'))).toEqual({})
	})

	it('gives a category with no products an empty record', () => {
		expect(migration.toValuesByKey(undefined)).toEqual({})
	})
})
