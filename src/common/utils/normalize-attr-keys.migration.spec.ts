import { ATTR_KEY_OVERRIDES, normalizeAttrLabel } from './attribute.utils'

type Fields = { keyField: string; labelField: string }
type Rename = { label: string; from: unknown; to: string }
type RenameResult<T> = { entries: T; renames: Rename[]; removedDuplicates: number }

// The migration duplicates the override table because it runs with plain `node`;
// this spec is the guard that keeps the copy in sync with the TypeScript source.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../scripts/migrations/normalize-attr-keys.js') as {
	ATTR_KEY_OVERRIDES: Record<string, string>
	normalizeAttrLabel: (label: string) => string
	renameAttributeKeys: <T>(entries: T, fields: Fields) => RenameResult<T>
	renameVariantTypeKey: <T>(variantType: T) => { variantType: T; rename: Rename | null }
}

const PRODUCT: Fields = { keyField: 'k', labelField: 'l' }
const CATEGORY: Fields = { keyField: 'key', labelField: 'label' }

type ProductAttr = { k: string; l: unknown; v: unknown }

const LIVE_ATTRS: ProductAttr[] = [
	{ k: 'vyrobnyk', l: 'Виробник', v: 'Creality' },
	{ k: 'vaha', l: 'Вага', v: 1000 },
	{ k: 'diametr', l: 'Діаметр', v: 1.75 },
	{ k: 'material', l: 'Матеріал', v: 'PLA' },
	{ k: 'kolir', l: 'Колір', v: 'Червоний' }
]

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('normalize-attr-keys migration', () => {
	describe('sync with attribute.utils', () => {
		it('ATTR_KEY_OVERRIDES is identical to the TypeScript table', () => {
			expect(migration.ATTR_KEY_OVERRIDES).toEqual(ATTR_KEY_OVERRIDES)
		})

		it.each([
			'Серія',
			'  Серія  ',
			'Тип  пластику',
			'Тип\tпластику',
			'СЕРІЯ',
			'ефект поверхні',
			'Ефект Поверхні',
			'Котушка в комплекті',
			'Ефект поверхнї', // decomposed "ї"
			'Виробник'
		])('normalizeAttrLabel agrees with the TypeScript one for %j', input => {
			expect(migration.normalizeAttrLabel(input)).toBe(normalizeAttrLabel(input))
		})
	})

	describe('renameAttributeKeys — product shape', () => {
		it('renames seriia → series keeping label, value and order', () => {
			const input: ProductAttr[] = [
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Creality' },
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'vaha', l: 'Вага', v: 1000 }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual([
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Creality' },
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'vaha', l: 'Вага', v: 1000 }
			])
			expect(result.renames).toEqual([{ label: 'Серія', from: 'seriia', to: 'series' }])
			expect(result.removedDuplicates).toBe(0)
		})

		it('reaches the override through label normalization', () => {
			const input: ProductAttr[] = [
				{ k: 'typ_plastyku', l: 'Тип  пластику', v: 'PLA' },
				{ k: 'seriia', l: ' СЕРІЯ ', v: 'Plus' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries.map(e => e.k)).toEqual(['polymer', 'series'])
			// The stored label is kept verbatim — only the key changes.
			expect(result.entries.map(e => e.l)).toEqual(['Тип  пластику', ' СЕРІЯ '])
		})

		it('leaves the five live production keys alone', () => {
			const result = migration.renameAttributeKeys(LIVE_ATTRS, PRODUCT)

			expect(result.entries).toEqual(LIVE_ATTRS)
			result.entries.forEach((entry, i) => expect(entry).toBe(LIVE_ATTRS[i]))
			expect(result.renames).toEqual([])
			expect(result.removedDuplicates).toBe(0)
		})

		it('leaves entries with a non-string label alone', () => {
			const input = [
				{ k: 'seriia', l: 42, v: 'Plus' },
				{ k: 'seriia', l: null, v: 'Plus' },
				{ k: 'seriia', v: 'Plus' },
				{ k: 'seriia', l: ['Серія'], v: 'Plus' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual(input)
			result.entries.forEach((entry, i) => expect(entry).toBe(input[i]))
			expect(result.renames).toEqual([])
		})

		it('collapses an exact duplicate created by the rename', () => {
			const input: ProductAttr[] = [
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Creality' },
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Plus' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual([
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Creality' },
				{ k: 'series', l: 'Серія', v: 'Plus' }
			])
			expect(result.renames).toEqual([{ label: 'Серія', from: 'seriia', to: 'series' }])
			expect(result.removedDuplicates).toBe(1)
		})

		it('collapses a pre-existing duplicate that already carried the target key', () => {
			// Documented in the script header: dedup spans every entry on a key that some
			// rename in this document targets, not only the entries the rename produced.
			const input: ProductAttr[] = [
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'seriia', l: 'Серія', v: 'Standard' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual([
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Standard' }
			])
			expect(result.removedDuplicates).toBe(1)
		})

		it('keeps distinct multi-values of a renamed key', () => {
			const input: ProductAttr[] = [
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'seriia', l: 'Серія', v: 'Standard' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual([
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Standard' }
			])
			expect(result.renames).toHaveLength(2)
			expect(result.removedDuplicates).toBe(0)
		})

		it('keeps a renamed entry whose label differs from an existing one (not an exact duplicate)', () => {
			const input: ProductAttr[] = [
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Series', v: 'Plus' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual([
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Series', v: 'Plus' }
			])
			expect(result.removedDuplicates).toBe(0)
		})

		it('leaves a pre-existing exact duplicate on an unrelated key alone', () => {
			const input: ProductAttr[] = [
				{ k: 'vaha', l: 'Вага', v: 1000 },
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'vaha', l: 'Вага', v: 1000 }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual([
				{ k: 'vaha', l: 'Вага', v: 1000 },
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'vaha', l: 'Вага', v: 1000 }
			])
			expect(result.removedDuplicates).toBe(0)
		})

		it('does not deduplicate at all when nothing was renamed', () => {
			const input: ProductAttr[] = [
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Plus' }
			]
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(result.entries).toEqual(input)
			expect(result.renames).toEqual([])
			expect(result.removedDuplicates).toBe(0)
		})

		it('does not mutate the input array or its objects', () => {
			const input: ProductAttr[] = [
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'vaha', l: 'Вага', v: 1000 }
			]
			const snapshot = clone(input)
			const result = migration.renameAttributeKeys(input, PRODUCT)

			expect(input).toEqual(snapshot)
			expect(result.entries).not.toBe(input)
			expect(result.entries[0]).not.toBe(input[0])
			// Untouched entries are passed through by reference.
			expect(result.entries[1]).toBe(input[2])
		})

		it('is idempotent', () => {
			const input: ProductAttr[] = [
				{ k: 'seriia', l: 'Серія', v: 'Plus' },
				{ k: 'series', l: 'Серія', v: 'Plus' },
				{ k: 'seriia', l: 'Серія', v: 'Standard' },
				{ k: 'typ_plastyku', l: 'Тип пластику', v: 'PETG' },
				...LIVE_ATTRS
			]
			const first = migration.renameAttributeKeys(input, PRODUCT)
			const second = migration.renameAttributeKeys(first.entries, PRODUCT)

			expect(second.entries).toEqual(first.entries)
			expect(second.renames).toEqual([])
			expect(second.removedDuplicates).toBe(0)
		})

		it.each([[undefined], [null], ['attributes'], [{ k: 'seriia', l: 'Серія', v: 'Plus' }]])(
			'passes non-array input %p through untouched',
			input => {
				const result = migration.renameAttributeKeys(input, PRODUCT)

				expect(result.entries).toBe(input)
				expect(result.renames).toEqual([])
				expect(result.removedDuplicates).toBe(0)
			}
		)
	})

	describe('renameVariantTypeKey', () => {
		// The API stores variant_type.key verbatim (VariantTypeDto.key is a plain @IsString()),
		// so unlike attributes[].k it is never repaired by a later save — this rename is the
		// only thing keeping it joinable with attributes[].k on the product page.
		it('overrides the key and keeps the label', () => {
			const input = { key: 'seriia', label: 'Серія' }
			const result = migration.renameVariantTypeKey(input)

			expect(result.variantType).toEqual({ key: 'series', label: 'Серія' })
			expect(result.rename).toEqual({ label: 'Серія', from: 'seriia', to: 'series' })
			expect(input).toEqual({ key: 'seriia', label: 'Серія' })
		})

		it('reaches the override through label normalization', () => {
			expect(
				migration.renameVariantTypeKey({ key: 'typ_plastyku', label: ' Тип  ПЛАСТИКУ ' })
					.variantType
			).toEqual({ key: 'polymer', label: ' Тип  ПЛАСТИКУ ' })
		})

		it('leaves the colour axis, the only one in production, untouched', () => {
			const input = { key: 'kolir', label: 'Колір' }
			const result = migration.renameVariantTypeKey(input)

			expect(result.variantType).toBe(input)
			expect(result.rename).toBeNull()
		})

		it('is idempotent once the key already matches', () => {
			const input = { key: 'series', label: 'Серія' }
			const result = migration.renameVariantTypeKey(input)

			expect(result.variantType).toBe(input)
			expect(result.rename).toBeNull()
		})

		it.each([[undefined], [null], ['color'], [42], [[{ key: 'seriia', label: 'Серія' }]]])(
			'passes %p through untouched',
			value => {
				const result = migration.renameVariantTypeKey(value)

				expect(result.variantType).toBe(value)
				expect(result.rename).toBeNull()
			}
		)

		it('ignores a variant type with a non-string label', () => {
			const input = { key: 'seriia', label: 42 }
			expect(migration.renameVariantTypeKey(input).rename).toBeNull()
		})
	})

	describe('renameAttributeKeys — category shape', () => {
		it('renames required_attributes[].key and keeps the other fields', () => {
			const input = [
				{ key: 'vyrobnyk', label: 'Виробник', filter_type: 'multi-select', unit: null },
				{ key: 'vaha', label: 'Вага', filter_type: 'range', unit: 'г' },
				{
					key: 'kotushka_v_komplekti',
					label: 'Котушка в комплекті',
					filter_type: 'multi-select',
					unit: null
				},
				{ key: 'seriia', label: 'Серія', filter_type: 'multi-select', unit: null }
			]
			const result = migration.renameAttributeKeys(input, CATEGORY)

			expect(result.entries).toEqual([
				{ key: 'vyrobnyk', label: 'Виробник', filter_type: 'multi-select', unit: null },
				{ key: 'vaha', label: 'Вага', filter_type: 'range', unit: 'г' },
				{
					key: 'spool_included',
					label: 'Котушка в комплекті',
					filter_type: 'multi-select',
					unit: null
				},
				{ key: 'series', label: 'Серія', filter_type: 'multi-select', unit: null }
			])
			expect(result.renames).toEqual([
				{
					label: 'Котушка в комплекті',
					from: 'kotushka_v_komplekti',
					to: 'spool_included'
				},
				{ label: 'Серія', from: 'seriia', to: 'series' }
			])
			expect(result.removedDuplicates).toBe(0)
		})
	})
})
