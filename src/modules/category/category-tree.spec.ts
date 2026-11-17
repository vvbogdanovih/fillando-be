import { CategoryTree, CategoryTreeError, CategoryTreeNode } from './category-tree'

const nodes: CategoryTreeNode[] = [
	{ id: 'electrical', parent_id: null, kind: 'group' },
	{ id: 'power', parent_id: 'electrical', kind: 'group' },
	{ id: 'avr', parent_id: 'power', kind: 'product' },
	{ id: 'blankets', parent_id: null, kind: 'product' },
	{ id: 'empty', parent_id: null, kind: 'group' }
]

function expectCode(call: () => unknown, code: CategoryTreeError['code']) {
	try {
		call()
		throw new Error('Expected a topology error')
	} catch (error) {
		expect(error).toBeInstanceOf(CategoryTreeError)
		expect((error as CategoryTreeError).code).toBe(code)
	}
}

it('finds leaf categories for group scope without unrelated roots or empty groups', () => {
	const tree = new CategoryTree(nodes)
	expect(tree.productCategoryIds('electrical')).toEqual(['avr'])
	expect(tree.productCategoryIds('avr')).toEqual(['avr'])
	expect(tree.productCategoryIds('empty')).toEqual([])
	expect(tree.ancestorIds('avr')).toEqual(['electrical', 'power'])
	expect(tree.ancestorIds('blankets')).toEqual([])
})

it('rejects self and descendant moves but allows reparenting or moving to root', () => {
	const tree = new CategoryTree(nodes)
	expectCode(() => tree.assertMove('electrical', 'power'), 'CATEGORY_CYCLE')
	expectCode(() => tree.assertMove('avr', 'avr'), 'CATEGORY_CYCLE')
	expectCode(() => tree.assertMove('power', 'avr'), 'PARENT_NOT_GROUP')
	expectCode(() => tree.assertMove('avr', 'missing'), 'UNKNOWN_PARENT')
	expectCode(() => tree.assertMove('missing', null), 'UNKNOWN_CATEGORY')
	expect(() => tree.assertMove('avr', 'empty')).not.toThrow()
	expect(() => tree.assertMove('power', null)).not.toThrow()
})

it('rejects corrupt snapshots before queries can loop or silently omit products', () => {
	expectCode(() => new CategoryTree([...nodes, nodes[0]]), 'DUPLICATE_ID')
	expectCode(
		() => new CategoryTree([{ id: 'a', parent_id: 'missing', kind: 'product' }]),
		'UNKNOWN_PARENT'
	)
	expectCode(
		() =>
			new CategoryTree([
				{ id: 'a', parent_id: 'b', kind: 'group' },
				{ id: 'b', parent_id: 'a', kind: 'group' }
			]),
		'CATEGORY_CYCLE'
	)
	expectCode(
		() =>
			new CategoryTree([
				{ id: 'a', parent_id: null, kind: 'product' },
				{ id: 'b', parent_id: 'a', kind: 'product' }
			]),
		'PARENT_NOT_GROUP'
	)
	expectCode(() => new CategoryTree([{ id: '', parent_id: null, kind: 'group' }]), 'INVALID_NODE')
})

it('does not retain mutable input or expose internal collections', () => {
	const input = nodes.map(node => ({ ...node }))
	const tree = new CategoryTree(input)
	input[0].parent_id = 'power'
	input[2].kind = 'group'
	tree.ancestorIds('avr').push('bad')
	expect(tree.ancestorIds('avr')).toEqual(['electrical', 'power'])
	expect(tree.productCategoryIds('electrical')).toEqual(['avr'])
})

it('supports a 20000-level chain without recursion or a business depth cap', () => {
	const depth = 20_000
	const input: CategoryTreeNode[] = Array.from({ length: depth }, (_, i) => ({
		id: String(i),
		parent_id: i === 0 ? null : String(i - 1),
		kind: i === depth - 1 ? 'product' : 'group'
	}))
	// Reverse order exercises validation starting at the deepest descendant.
	const tree = new CategoryTree(input.reverse())
	expect(tree.ancestorIds(String(depth - 1))).toHaveLength(depth - 1)
	expect(tree.productCategoryIds('0')).toEqual([String(depth - 1)])
	expectCode(() => tree.assertMove('0', String(depth - 2)), 'CATEGORY_CYCLE')
})

it('rejects unknown lookup roots rather than returning an empty valid catalogue', () => {
	const tree = new CategoryTree([])
	expectCode(() => tree.productCategoryIds('gone'), 'UNKNOWN_CATEGORY')
	expectCode(() => tree.ancestorIds('gone'), 'UNKNOWN_CATEGORY')
})

it('supports broad groups without spreading child arrays onto the call stack', () => {
	const leaves: CategoryTreeNode[] = Array.from({ length: 150_000 }, (_, i) => ({
		id: `leaf-${i}`,
		parent_id: 'root',
		kind: 'product'
	}))
	const tree = new CategoryTree([{ id: 'root', parent_id: null, kind: 'group' }, ...leaves])
	expect(tree.productCategoryIds('root')).toHaveLength(leaves.length)
})
