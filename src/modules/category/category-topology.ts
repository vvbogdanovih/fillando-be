import { mongo, type Connection } from 'mongoose'
import { CategoryTreeError } from './category-tree'
import { CATEGORY_MEMO_MS, categoryFingerprint } from './category-fingerprint'

/**
 * One category's placement and identity as every tree reader needs it (Plan-0010 D06.3). One
 * object per category, shared by all views: the admin tree, the public tree and its options, the
 * public reader's light nodes. `parent_id` is the parent's own `_id` string.
 */
export interface TopologyNode {
	_id: string
	parent_id: string | null
	kind: 'group' | 'product'
	status: 'draft' | 'active' | 'archived'
	name: string
	slug: string
	order: number
	/** The stored contract version when it is 1 or 2 (absent = 1); `null` for anything else. */
	attribute_contract_version: 1 | 2 | null
	image: string | null
	/** v1 `required_attributes` / v2 `attribute_definitions`, counted by the server. */
	attribute_count: number
	/** Active, and every ancestor active: the public trees show it. */
	visible: boolean
	/** The catalogue revision the topology was read under. */
	revision: number
}

/** Every category of one read, validated as one tree. */
export interface CategoryTopology {
	/** Every category, `_id` ascending — the admin tree's order. */
	all: TopologyNode[]
	/** The visible ones, `_id` ascending — the public tree's order. */
	visible: TopologyNode[]
	byId: Map<string, TopologyNode>
	/** Something only the journal creates (v2, a group, nesting): needs `catalog_control`. */
	typed: boolean
	/**
	 * Why the stored categories are not a valid tree (metadata, ids, order, topology), or `null`.
	 * Every view refuses an invalid topology — the tree pages with their 503, the public reader
	 * with its own — as `projectCategoryTree` did for each of them.
	 */
	invalid: Error | null
	/** Derived views of this topology (snapshots, sorted lists, indexes), built once each. */
	views: Map<string, unknown>
}

const PROJECTION = {
	_id: 1,
	parent_id: 1,
	kind: 1,
	status: 1,
	name: 1,
	slug: 1,
	order: 1,
	attribute_contract_version: 1,
	image: 1,
	attribute_count: {
		$cond: [
			{ $eq: ['$attribute_contract_version', 2] },
			{
				$cond: [
					{ $isArray: '$attribute_definitions' },
					{ $size: '$attribute_definitions' },
					0
				]
			},
			{
				$cond: [{ $isArray: '$required_attributes' }, { $size: '$required_attributes' }, 0]
			}
		]
	}
}

const HEX_ID = /^[a-f0-9]{24}$/
function idString(value: unknown): string {
	if (value instanceof mongo.ObjectId) return value.toHexString()
	if (typeof value === 'string') return value
	throw new Error('INVALID_CATEGORY_ID')
}

/**
 * Builds the topology from the stored placement fields, one row at a time — the checks of
 * `projectCategoryTree` (metadata, ids, order, then the tree: duplicate ids, unknown or
 * non-group parents, cycles) and its visibility rule, without holding the raw rows or a second
 * copy of any category: at 150 000 categories `toArray()` plus the `CategoryTree` copies peaked
 * at ~450 MiB above the live heap (Plan-0010 D06). An invalid collection still yields a
 * topology, marked `invalid`.
 */
export class TopologyBuilder {
	private readonly all: TopologyNode[] = []
	private readonly byId = new Map<string, TopologyNode>()
	private typed = false
	private invalid: Error | null = null
	constructor(private readonly revision: number) {}

	add(row: Record<string, unknown>): void {
		// Over every stored row, valid or not, as the tree pages always checked it.
		if (row.attribute_contract_version === 2 || row.kind === 'group' || row.parent_id != null)
			this.typed = true
		if (this.invalid) return
		try {
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
			const id = idString(row._id)
			const parent = row.parent_id == null ? null : idString(row.parent_id)
			if (!HEX_ID.test(id) || (parent !== null && !HEX_ID.test(parent)))
				throw new Error('INVALID_CATEGORY_ID')
			const order = row.order === undefined ? 0 : row.order
			if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0)
				throw new Error('INVALID_CATEGORY_ORDER')
			if (this.byId.has(id)) throw new CategoryTreeError('DUPLICATE_ID', id)
			const version = row.attribute_contract_version ?? 1
			const node: TopologyNode = {
				_id: id,
				parent_id: parent,
				kind: kind as TopologyNode['kind'],
				status: status as TopologyNode['status'],
				name: row.name,
				slug: row.slug,
				order,
				attribute_contract_version: version === 1 || version === 2 ? version : null,
				image: typeof row.image === 'string' ? row.image : null,
				attribute_count: typeof row.attribute_count === 'number' ? row.attribute_count : 0,
				visible: false,
				revision: this.revision
			}
			this.all.push(node)
			this.byId.set(id, node)
		} catch (error) {
			this.invalid = error as Error
		}
	}

	finish(): CategoryTopology {
		const { all, byId } = this
		if (!this.invalid)
			try {
				for (const node of all) {
					if (node.parent_id === null) continue
					const parent = byId.get(node.parent_id)
					if (!parent) throw new CategoryTreeError('UNKNOWN_PARENT', node._id)
					if (parent.kind !== 'group')
						throw new CategoryTreeError('PARENT_NOT_GROUP', node._id)
					// The parent's own id string, not a second copy of it per child.
					node.parent_id = parent._id
				}
				// Each node is walked once: up to a known node or the root, a revisited node in
				// the current walk is a cycle. Visibility follows the same walk down.
				const known = new Set<TopologyNode>()
				for (const node of all) {
					const path: TopologyNode[] = []
					const inPath = new Set<TopologyNode>()
					let current: TopologyNode | undefined = node
					while (current && !known.has(current)) {
						if (inPath.has(current))
							throw new CategoryTreeError('CATEGORY_CYCLE', current._id)
						inPath.add(current)
						path.push(current)
						current =
							current.parent_id === null ? undefined : byId.get(current.parent_id)
					}
					let visible = current ? current.visible : true
					for (let index = path.length - 1; index >= 0; index--) {
						visible = visible && path[index].status === 'active'
						path[index].visible = visible
						known.add(path[index])
					}
				}
				all.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
			} catch (error) {
				this.invalid = error as Error
			}
		return {
			all,
			visible: this.invalid ? [] : all.filter(node => node.visible),
			byId,
			typed: this.typed,
			invalid: this.invalid,
			views: new Map()
		}
	}
}

/** The topology of rows already in memory (specs). */
export function buildTopology(rows: Record<string, unknown>[], revision: number): CategoryTopology {
	const builder = new TopologyBuilder(revision)
	for (const row of rows) builder.add(row)
	return builder.finish()
}

/** A view of a topology, built on first use and kept with it. */
export function viewOf<T>(topology: CategoryTopology, name: string, build: () => T): T {
	if (!topology.views.has(name)) topology.views.set(name, build())
	return topology.views.get(name) as T
}

/**
 * The topology of the `categories` collection under a catalogue stamp, one per connection and
 * key: keyed by the stamp and `categoryFingerprint` (an O(1) write mark), reused at most
 * `CATEGORY_MEMO_MS`, one read shared by every concurrent caller that missed it. Both tree
 * readers use it — at 150 000 categories three separate copies (the public reader, the public and
 * the admin tree pages) ran a 400 MB heap out of memory (Plan-0010 D06). `key` is `null` on a
 * server without a fingerprint: the topology is then read for this call only.
 */
const memos = new WeakMap<
	Connection,
	{ key: string; at: number; topology: Promise<CategoryTopology> } | null
>()
export async function categoryTopology(
	connection: Connection,
	stamp: { revision: number; epoch: number; initialized: boolean }
): Promise<{ key: string | null; topology: Promise<CategoryTopology> }> {
	const content = await categoryFingerprint(connection)
	const key =
		content === null
			? null
			: JSON.stringify([stamp.initialized, stamp.revision, stamp.epoch, content])
	const memo = memos.get(connection)
	if (key !== null && memo && memo.key === key && Date.now() - memo.at < CATEGORY_MEMO_MS)
		return { key, topology: memo.topology }
	const topology = (async () => {
		const builder = new TopologyBuilder(stamp.revision)
		for await (const row of connection
			.collection('categories')
			.find({}, { readPreference: 'primary', projection: PROJECTION, batchSize: 5000 }))
			builder.add(row)
		return builder.finish()
	})()
	if (key !== null) {
		const entry = { key, at: Date.now(), topology }
		memos.set(connection, entry)
		topology.catch(() => {
			if (memos.get(connection) === entry) memos.set(connection, null)
		})
	}
	return { key, topology }
}
