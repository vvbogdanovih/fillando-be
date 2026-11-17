import { mongo } from 'mongoose'
import { CategoryTree } from './category-tree'

function idString(value: unknown): string {
	if (value instanceof mongo.ObjectId) return value.toHexString()
	if (typeof value === 'string') return value
	throw new Error('INVALID_CATEGORY_ID')
}

export interface CategoryTreeItem {
	_id: string
	parent_id: string | null
	kind: 'group' | 'product'
	status: 'draft' | 'active' | 'archived'
	name: string
	slug: string
	order: number
	attribute_contract_version?: number
	/** Admin only: the tile image the new admin edits («Деталі категорії»). */
	image?: string | null
}

/** Iterative visibility propagation: a hidden ancestor hides its entire public branch. */
export function projectCategoryTree(
	rows: Record<string, unknown>[],
	admin: boolean
): CategoryTreeItem[] {
	const items: CategoryTreeItem[] = rows.map(row => {
		const kind = row.kind === undefined ? 'product' : row.kind
		const status = row.status === undefined ? 'active' : row.status
		if (
			typeof kind !== 'string' ||
			!['group', 'product'].includes(kind) ||
			typeof status !== 'string' ||
			!['draft', 'active', 'archived'].includes(status) ||
			typeof row.name !== 'string' ||
			typeof row.slug !== 'string'
		)
			throw new Error('INVALID_CATEGORY_METADATA')
		if (
			!/^[a-f0-9]{24}$/.test(idString(row._id)) ||
			(row.parent_id != null && !/^[a-f0-9]{24}$/.test(idString(row.parent_id)))
		)
			throw new Error('INVALID_CATEGORY_ID')
		const order = row.order === undefined ? 0 : row.order
		if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0)
			throw new Error('INVALID_CATEGORY_ORDER')
		return {
			_id: idString(row._id),
			...(admin
				? {
						attribute_contract_version: row.attribute_contract_version === 2 ? 2 : 1,
						image: typeof row.image === 'string' ? row.image : null
					}
				: {}),
			parent_id: row.parent_id == null ? null : idString(row.parent_id),
			kind: kind as CategoryTreeItem['kind'],
			status: status as CategoryTreeItem['status'],
			name: row.name,
			slug: row.slug,
			order
		}
	})
	new CategoryTree(
		items.map(item => ({ id: item._id, parent_id: item.parent_id, kind: item.kind }))
	)
	if (admin) return items.sort((a, b) => a._id.localeCompare(b._id))
	const byId = new Map(items.map(item => [item._id, item]))
	const visibility = new Map<string, boolean>()
	for (const item of items) {
		const path: CategoryTreeItem[] = []
		let current: CategoryTreeItem | undefined = item
		while (current && !visibility.has(current._id)) {
			path.push(current)
			current = current.parent_id === null ? undefined : byId.get(current.parent_id)
		}
		let visible = current ? visibility.get(current._id)! : true
		for (let index = path.length - 1; index >= 0; index--) {
			visible = visible && path[index].status === 'active'
			visibility.set(path[index]._id, visible)
		}
	}
	return items.filter(item => visibility.get(item._id)).sort((a, b) => a._id.localeCompare(b._id))
}
