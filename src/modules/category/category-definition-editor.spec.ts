import {
	categoryControls,
	definitionsInputSchema,
	resolveDefinitions
} from './category-definition-editor'
const number = {
	label: 'Струм',
	value_type: 'number' as const,
	unit: 'А',
	is_required: true,
	filter_enabled: true,
	filter_type: 'range' as const,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic' as const,
	options: []
}
it('assigns stable server identities per operation and preserves identity on rename', () => {
	const first = resolveDefinitions([], [number], 'operation')
	expect(resolveDefinitions([], [number], 'operation')).toEqual(first)
	expect(
		resolveDefinitions(first, [{ ...first[0], label: 'Номінальний струм' }], 'rename')[0].key
	).toBe(first[0].key)
	expect(resolveDefinitions([], [number], 'copy')[0].key).not.toBe(first[0].key)
})
it('refuses foreign keys and option identities', () => {
	expect(() => resolveDefinitions([], [{ ...number, key: 'foreign' }], 'op')).toThrow(
		'UNKNOWN_KEY'
	)
	expect(() =>
		resolveDefinitions(
			[],
			[
				{
					...number,
					value_type: 'enum',
					filter_type: 'multi-select',
					options: [{ id: 'foreign', label: 'One', order: 0 }]
				}
			],
			'op'
		)
	).toThrow('UNKNOWN_KEY')
})
it('rejects inconsistent filter/type/multiplicity combinations', () => {
	for (const patch of [{ multiple: true }, { value_type: 'string' }, { filter_enabled: false }]) {
		expect(() =>
			resolveDefinitions([], [{ ...number, ...patch } as typeof number], 'op')
		).toThrow('INVALID_DEFINITION')
	}
	expect(definitionsInputSchema.safeParse([{ ...number, label: ' ' }]).success).toBe(false)
	expect(
		definitionsInputSchema.safeParse(Array.from({ length: 101 }, () => number)).success
	).toBe(false)
})
it('derives controls only from explicit definitions', () => {
	const before = resolveDefinitions(
		[],
		[
			{
				...number,
				value_type: 'enum',
				filter_type: 'multi-select',
				options: [
					{ label: 'Червоний', order: 0 },
					{ label: 'Білий', order: 1 }
				]
			}
		],
		'op'
	)
	const hidden = {
		...before[0],
		key: 'hidden',
		filter_enabled: false,
		filter_type: null,
		visible_in_specs: false,
		multiple: true
	}
	const controls = categoryControls([...before, hidden])
	expect(controls.filters).toHaveLength(1)
	expect(controls.fields).toHaveLength(2)
	expect(controls.variant_axes).toEqual([before[0].key])
})
