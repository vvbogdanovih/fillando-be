import { ATTR_KEY_OVERRIDES, generateAttrKey, normalizeAttrLabel } from './attribute.utils'

/** Catalogue filter dimensions pinned by TD-0002 §5.2.1 — label as an admin would type it → key. */
const OVERRIDE_TABLE: [label: string, key: string][] = [
	['Тип пластику', 'polymer'],
	['Ефект поверхні', 'finish'],
	['Армування', 'reinforcement'],
	['Серія', 'series'],
	['Котушка в комплекті', 'spool_included']
]

/** Keys currently stored in production — the override table must not touch them. */
const LIVE_KEYS: [label: string, key: string][] = [
	['Виробник', 'vyrobnyk'],
	['Вага', 'vaha'],
	['Діаметр', 'diametr'],
	['Матеріал', 'material'],
	['Колір', 'kolir']
]

describe('normalizeAttrLabel', () => {
	it.each([
		['leading and trailing spaces', '  Серія  ', 'серія'],
		['several inner spaces', 'Тип   пластику', 'тип пластику'],
		['a tab as separator', 'Тип\tпластику', 'тип пластику'],
		['a non-breaking space (U+00A0)', 'Тип\u00A0пластику', 'тип пластику'],
		['a non-breaking space around the label', '\u00A0Серія\u00A0', 'серія'],
		['upper case', 'СЕРІЯ', 'серія'],
		['mixed case', 'кОтУшКа В кОмПлЕкТі', 'котушка в комплекті']
	])('folds %s', (_case, input, expected) => {
		expect(normalizeAttrLabel(input)).toBe(expected)
	})

	it('composes decomposed Unicode input (NFC)', () => {
		// і + combining diaeresis → ї, и + combining breve → й
		expect(normalizeAttrLabel('\u0456\u0308')).toBe('\u0457')
		expect(normalizeAttrLabel('\u0438\u0306')).toBe('\u0439')
		expect('\u0456\u0308').not.toBe('\u0457')
	})
})

describe('generateAttrKey', () => {
	describe('override table', () => {
		it.each(OVERRIDE_TABLE)('%s → %s', (label, key) => {
			expect(generateAttrKey(label)).toBe(key)
		})

		it.each([
			['leading and trailing spaces', '  Серія  ', 'series'],
			['several inner spaces', 'Тип   пластику', 'polymer'],
			['a tab as separator', 'Тип\tпластику', 'polymer'],
			['a non-breaking space (U+00A0)', 'Тип\u00A0пластику', 'polymer'],
			['a non-breaking space around the label', '\u00A0Серія\u00A0', 'series'],
			['upper case', 'СЕРІЯ', 'series'],
			['lower case', 'ефект поверхні', 'finish'],
			['mixed case', 'кОтУшКа В кОмПлЕкТі', 'spool_included']
		])('reaches the override despite %s', (_case, input, key) => {
			expect(generateAttrKey(input)).toBe(key)
		})

		it('gives decomposed and composed spellings of a label the same key', () => {
			// The lookup normalizes to NFC, the fallback to NFD — neither may depend on the
			// input form. None of today's five override labels contains a composable letter
			// (`і`, `я`, `и` are atomic), so the end-to-end case runs through the fallback;
			// the override side of NFC is covered by the normalizeAttrLabel suite above.
			expect(generateAttrKey('Кра\u0456\u0308на')).toBe(generateAttrKey('Країна'))
			expect(generateAttrKey('Кра\u0456\u0308на')).toBe('kraina')
		})

		it('does not fold Latin homoglyphs of Cyrillic letters into the override', () => {
			// 'поверхнi' with a Latin i (U+0069) is a different string, so it transliterates
			// instead of matching. Labels are written by seeds, migrations and the admin form;
			// a homoglyph typo is fixed by correcting the label, not by fuzzy matching here.
			expect(generateAttrKey('Ефект поверхн\u0456')).toBe('finish')
			expect(generateAttrKey('Ефект поверхni')).toBe('efekt_poverkhni')
		})

		it('leaves a Latin label that transliterates to the same key unchanged', () => {
			expect(generateAttrKey('Series')).toBe('series')
		})
	})

	describe('keys live in production (regression guard)', () => {
		it.each(LIVE_KEYS)('%s → %s', (label, key) => {
			expect(generateAttrKey(label)).toBe(key)
		})
	})

	describe('fallback transliteration', () => {
		it.each([
			['Температура друку (°C)', 'temperatura_druku_c'],
			['Швидкість-друку', 'shvydkist_druku'],
			['Країна', 'kraina'],
			['Йод', 'yod']
		])('%s → %s', (label, key) => {
			expect(generateAttrKey(label)).toBe(key)
		})
	})

	describe('prototype-key safety', () => {
		it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
			'%s yields a plain string, never an inherited property',
			label => {
				const key = generateAttrKey(label)
				expect(typeof key).toBe('string')
				expect(key).toBe(label.toLowerCase())
			}
		)
	})
})

describe('ATTR_KEY_OVERRIDES', () => {
	it('contains exactly the five catalogue filter dimensions', () => {
		expect(ATTR_KEY_OVERRIDES).toEqual({
			'тип пластику': 'polymer',
			'ефект поверхні': 'finish',
			армування: 'reinforcement',
			серія: 'series',
			'котушка в комплекті': 'spool_included'
		})
	})

	it('stores every label already in normalized form', () => {
		for (const label of Object.keys(ATTR_KEY_OVERRIDES)) {
			expect(normalizeAttrLabel(label)).toBe(label)
		}
	})

	it('uses stable identifiers as values', () => {
		for (const key of Object.values(ATTR_KEY_OVERRIDES)) {
			expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
		}
	})

	it('has unique values', () => {
		const values = Object.values(ATTR_KEY_OVERRIDES)
		expect(new Set(values).size).toBe(values.length)
	})

	it('every value is a fixed point of generateAttrKey', () => {
		for (const key of Object.values(ATTR_KEY_OVERRIDES)) {
			expect(generateAttrKey(key)).toBe(key)
		}
	})
})
