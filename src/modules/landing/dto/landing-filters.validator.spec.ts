import { IsLandingFiltersConstraint } from './landing-filters.validator'

const validate = (value: unknown) => new IsLandingFiltersConstraint().validate(value)

describe('IsLandingFiltersConstraint', () => {
	it.each([
		['a single pinned dimension', { polymer: ['PLA'] }],
		['several dimensions', { polymer: ['PLA'], finish: ['Silk'] }],
		['several values in one dimension', { finish: ['Glow', 'Luminous'] }],
		['a key with an underscore', { spool_included: ['Ні (рефіл)'] }],
		['no filters at all', {}]
	])('accepts %s', (_case, value) => {
		expect(validate(value)).toBe(true)
	})

	it('rejects a value containing a comma', () => {
		// `ProductService.getCatalog` splits query values on the comma, so a stored value with
		// one could never be matched back (TD-0002 §5.2.1).
		expect(validate({ series: ['Plus, Standard'] })).toBe(false)
	})

	it.each([
		['a transliterated key with capitals', { Polymer: ['PLA'] }],
		['a key starting with a digit', { '2polymer': ['PLA'] }],
		['a key with a dash', { 'spool-included': ['Так'] }]
	])('rejects %s', (_case, value) => {
		expect(validate(value)).toBe(false)
	})

	it.each([
		['an empty value list', { polymer: [] }],
		['a non-array value', { polymer: 'PLA' }],
		['a non-string entry', { polymer: [42] }],
		['a blank entry', { polymer: ['   '] }],
		['an array instead of an object', [{ polymer: ['PLA'] }]],
		['null', null],
		['a string', 'polymer=PLA']
	])('rejects %s', (_case, value) => {
		expect(validate(value)).toBe(false)
	})

	it('explains which filter and value are at fault', () => {
		const constraint = new IsLandingFiltersConstraint()
		constraint.validate({ series: ['Plus, Standard'] })
		const message = constraint.defaultMessage()

		expect(message).toContain('series')
		expect(message).toContain('comma')
	})
})
