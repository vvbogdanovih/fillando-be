/**
 * Pure topology checks for TD-0013. No recursive traversal or fixed depth limit.
 * Persistence must serialize topology writes: validating a snapshot alone does not
 * prevent two concurrent moves from creating a cycle.
 */
export interface CategoryTreeNode {
	id: string
	parent_id: string | null
	kind: 'group' | 'product'
}

export class CategoryTreeError extends Error {
	constructor(
		readonly code:
			| 'INVALID_NODE'
			| 'DUPLICATE_ID'
			| 'UNKNOWN_CATEGORY'
			| 'UNKNOWN_PARENT'
			| 'PARENT_NOT_GROUP'
			| 'CATEGORY_CYCLE',
		readonly categoryId: string
	) {
		super(`${code}: ${categoryId}`)
		this.name = 'CategoryTreeError'
	}
}

/** Holds a private copy so callers cannot invalidate an already checked topology. */
export class CategoryTree {
	private readonly nodes = new Map<string, CategoryTreeNode>()
	private readonly children = new Map<string, string[]>()

	constructor(nodes: readonly CategoryTreeNode[]) {
		for (const node of nodes) {
			if (
				typeof node?.id !== 'string' ||
				!node.id ||
				(node.parent_id !== null &&
					(typeof node.parent_id !== 'string' || !node.parent_id)) ||
				!['group', 'product'].includes(node.kind)
			) {
				throw new CategoryTreeError('INVALID_NODE', node?.id ?? '')
			}
			if (this.nodes.has(node.id)) throw new CategoryTreeError('DUPLICATE_ID', node.id)
			this.nodes.set(node.id, { ...node })
		}
		for (const node of this.nodes.values()) {
			if (node.parent_id === null) continue
			const parent = this.nodes.get(node.parent_id)
			if (!parent) throw new CategoryTreeError('UNKNOWN_PARENT', node.id)
			if (parent.kind !== 'group') throw new CategoryTreeError('PARENT_NOT_GROUP', node.id)
			const siblings = this.children.get(parent.id) ?? []
			siblings.push(node.id)
			this.children.set(parent.id, siblings)
		}

		// Each node is visited at most once while validating all parent chains.
		const finished = new Set<string>()
		for (const node of this.nodes.values()) {
			const path = new Set<string>()
			let current: string | null = node.id
			while (current !== null && !finished.has(current)) {
				if (path.has(current)) throw new CategoryTreeError('CATEGORY_CYCLE', current)
				path.add(current)
				current = this.nodes.get(current)!.parent_id
			}
			for (const visited of path) finished.add(visited)
		}
	}

	private node(id: string): CategoryTreeNode {
		const node = this.nodes.get(id)
		if (!node) throw new CategoryTreeError('UNKNOWN_CATEGORY', id)
		return node
	}

	/** Root first, excludes the current category. */
	ancestorIds(id: string): string[] {
		const ancestors: string[] = []
		let parent = this.node(id).parent_id
		while (parent !== null) {
			ancestors.push(parent)
			parent = this.node(parent).parent_id
		}
		return ancestors.reverse()
	}

	/** Includes this node only if it accepts products; sibling branches stay isolated. */
	productCategoryIds(id: string): string[] {
		this.node(id)
		const pending = [id]
		const result: string[] = []
		for (let i = 0; i < pending.length; i++) {
			const current = this.node(pending[i])
			if (current.kind === 'product') result.push(current.id)
			for (const child of this.children.get(current.id) ?? []) pending.push(child)
		}
		return result
	}

	/** Validate only; the caller applies a move to storage under concurrency protection. */
	assertMove(id: string, parentId: string | null): void {
		this.node(id)
		if (parentId === null) return
		if (parentId === id) throw new CategoryTreeError('CATEGORY_CYCLE', id)
		const parent = this.nodes.get(parentId)
		if (!parent) throw new CategoryTreeError('UNKNOWN_PARENT', id)
		if (parent.kind !== 'group') throw new CategoryTreeError('PARENT_NOT_GROUP', id)
		let current: string | null = parentId
		while (current !== null) {
			if (current === id) throw new CategoryTreeError('CATEGORY_CYCLE', id)
			current = this.node(current).parent_id
		}
	}
}
