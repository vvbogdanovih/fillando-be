import { resolveProductType, type LandingForProductType } from './product-type.resolver'

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
