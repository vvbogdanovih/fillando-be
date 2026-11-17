import {
	resolveProductType,
	typedLandingPins,
	type LandingForProductType
} from './product-type.resolver'

const CAT = '000000000000000000000003'
const OTHER = '000000000000000000000009'

const landing = (
	h1: string,
	filters: Record<string, string[]>,
	order = 0,
	category_id = CAT
): LandingForProductType => ({ category_id, h1, filters, order })

const PLA_SILK = [
	{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
	{ k: 'finish', l: 'Ефект поверхні', v: 'Silk' },
	{ k: 'spool_included', l: 'Котушка в комплекті', v: 'Так' }
]

describe('resolveProductType', () => {
	it('falls back to the category name when no landing matches', () => {
		expect(resolveProductType('Філамент', CAT, PLA_SILK, [])).toEqual({
			product_type: 'Філамент',
			landing: null
		})
		expect(
			resolveProductType('Філамент', CAT, PLA_SILK, [landing('PETG', { polymer: ['PETG'] })])
				.product_type
		).toBe('Філамент')
	})

	it('appends the H1 of the matching landing', () => {
		const result = resolveProductType('Філамент', CAT, PLA_SILK, [
			landing('PLA філамент', { polymer: ['PLA'] })
		])
		expect(result.product_type).toBe('Філамент > PLA філамент')
	})

	it('requires every pinned filter to match, not just one', () => {
		const result = resolveProductType('Філамент', CAT, PLA_SILK, [
			landing('PLA Matte', { polymer: ['PLA'], finish: ['Matte'] })
		])
		expect(result.landing).toBeNull()
	})

	it('prefers the most specific landing, then the lower order', () => {
		const landings = [
			landing('PLA філамент', { polymer: ['PLA'] }, 10),
			landing('PLA Silk філамент', { polymer: ['PLA'], finish: ['Silk'] }, 30),
			landing('Silk (усі)', { finish: ['Silk'] }, 5)
		]
		expect(resolveProductType('Філамент', CAT, PLA_SILK, landings).product_type).toBe(
			'Філамент > PLA Silk філамент'
		)

		const tie = [
			landing('Другий', { polymer: ['PLA'] }, 20),
			landing('Перший', { finish: ['Silk'] }, 10)
		]
		expect(resolveProductType('Філамент', CAT, PLA_SILK, tie).product_type).toBe(
			'Філамент > Перший'
		)
	})

	it('ignores landings of another category even when the filters would match', () => {
		const result = resolveProductType('Філамент', CAT, PLA_SILK, [
			landing('PLA', { polymer: ['PLA'] }, 0, OTHER)
		])
		expect(result.landing).toBeNull()
	})

	it('matches a multi-valued attribute stored as separate entries', () => {
		const attrs = [
			{ k: 'reinforcement', l: 'Армування', v: 'CF' },
			{ k: 'reinforcement', l: 'Армування', v: 'GF' }
		]
		expect(
			resolveProductType('Філамент', CAT, attrs, [landing('GF', { reinforcement: ['GF'] })])
				.product_type
		).toBe('Філамент > GF')
	})

	it('never matches a landing with no pinned filters', () => {
		expect(
			resolveProductType('Філамент', CAT, PLA_SILK, [landing('Усе', {})]).landing
		).toBeNull()
	})
})

describe('typed landings (filters_v2) — the pins the storefront lists by', () => {
	const typed = (h1: string, filtersV2: unknown, order = 0): LandingForProductType => ({
		category_id: CAT,
		h1,
		order,
		pins: typedLandingPins(filtersV2)!
	})
	// The product's typed values: attributes_v2 plus its SKU's axis value.
	const AVR = [
		{ k: 'current', v: 63 },
		{ k: 'phases', v: '3' },
		{ k: 'brand_line', v: 'Pro' }
	]
	it('matches discrete values and numeric ranges against the typed values, not the rows', () => {
		const landings = [
			typed('АВР 63 А', { attributes: [{ key: 'current', min: 63, max: 63 }] }),
			typed('Трифазні 40–80 А', {
				attributes: [
					{ key: 'phases', values: ['3'] },
					{ key: 'current', min: 40, max: 80 }
				]
			}),
			typed('АВР 16 А', { attributes: [{ key: 'current', max: 16 }] })
		]
		// The legacy rows say nothing about these keys: only the typed values decide.
		expect(resolveProductType('АВР', CAT, [], landings, AVR).product_type).toBe(
			'АВР > Трифазні 40–80 А'
		)
		expect(
			resolveProductType('АВР', CAT, [], landings, [{ k: 'current', v: 16 }]).product_type
		).toBe('АВР > АВР 16 А')
		// A string «63» is not the number 63, as on the storefront.
		expect(
			resolveProductType('АВР', CAT, [], landings, [{ k: 'current', v: '63' }]).landing
		).toBeNull()
	})
	it('uses the current pins, never stale legacy ones of a re-pinned landing', () => {
		const repinned: LandingForProductType = {
			...typed('Silk', { attributes: [{ key: 'finish', values: ['Silk'] }] }),
			filters: { polymer: ['PETG'] }
		}
		const values = [
			{ k: 'polymer', v: 'PLA' },
			{ k: 'finish', v: 'Silk' }
		]
		expect(resolveProductType('Філамент', CAT, PLA_SILK, [repinned], values).product_type).toBe(
			'Філамент > Silk'
		)
	})
	it('reads only attribute pins; a landing pinning anything else never types', () => {
		expect(
			typedLandingPins({
				attributes: [{ key: 'polymer', values: ['PLA'] }],
				category_ids: [],
				brand_ids: [],
				color_families: []
			})
		).toEqual([{ key: 'polymer', values: ['PLA'] }])
		for (const other of [
			{ attributes: [{ key: 'polymer', values: ['PLA'] }], color_families: ['black'] },
			{ attributes: [], price: { max: 500 } },
			{ attributes: [{ key: 'polymer', values: ['PLA'] }], in_stock: true },
			{ attributes: [] },
			{ current: { min: 63, max: 63 } },
			null
		])
			expect(typedLandingPins(other)).toBeNull()
	})
})
