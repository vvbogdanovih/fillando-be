import { readCategoryConfiguration } from './category-configuration'

it('reads historical categories as v1 leaves without writing or guessing definitions', () => {
	const input = { name: 'Філамент', required_attributes: [{ key: 'vaha', label: 'Вага' }] }
	expect(readCategoryConfiguration(input)).toEqual({
		parent_id: null,
		kind: 'product',
		status: 'active',
		attribute_contract_version: 1,
		attribute_definitions: null
	})
	expect(input).not.toHaveProperty('attribute_contract_version')
})
it('does not activate staged definitions while the category is still v1', () => {
	expect(
		readCategoryConfiguration({ attribute_definitions: [{ broken: true }] })
			.attribute_definitions
	).toBeNull()
})
it('accepts explicit v2 groups and leaves', () => {
	const group = {
		kind: 'group',
		status: 'draft',
		attribute_contract_version: 2,
		attribute_definitions: []
	}
	expect(readCategoryConfiguration(group).kind).toBe('group')
	expect(
		readCategoryConfiguration({
			...group,
			kind: 'product',
			parent_id: '000000000000000000000001'
		}).parent_id
	).toBe('000000000000000000000001')
})
it.each([
	{ kind: 'group' },
	{ parent_id: '000000000000000000000001' },
	{ attribute_contract_version: 3 },
	{ attribute_contract_version: null },
	{ status: 'published' },
	{ parent_id: 'bad' },
	{ kind: null }
])('rejects corrupt or prematurely enabled configuration %j', input => {
	expect(() => readCategoryConfiguration(input)).toThrow('INVALID_CONFIGURATION')
})
it('requires explicit definitions for v2, including empty definitions', () => {
	expect(() => readCategoryConfiguration({ attribute_contract_version: 2 })).toThrow(
		'MISSING_DEFINITIONS'
	)
	expect(() =>
		readCategoryConfiguration({ attribute_contract_version: 2, attribute_definitions: null })
	).toThrow('INVALID_DEFINITION')
})
it('rejects product attributes on group nodes', () => {
	const definition = {
		key: 'size',
		label: 'Розмір',
		value_type: 'string',
		unit: null,
		is_required: false,
		filter_enabled: false,
		filter_type: null,
		visible_in_specs: true,
		order: 0,
		multiple: false,
		semantic: 'size',
		options: []
	}
	expect(() =>
		readCategoryConfiguration({
			kind: 'group',
			attribute_contract_version: 2,
			attribute_definitions: [definition]
		})
	).toThrow('GROUP_ATTRIBUTES')
})
