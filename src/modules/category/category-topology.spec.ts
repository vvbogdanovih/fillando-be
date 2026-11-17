import { mongo } from 'mongoose'
import { projectCategoryTree } from './category-tree-read'
import { buildTopology } from './category-topology'

/**
 * Plan-0010 D06.3: the shared topology must accept and refuse exactly what `projectCategoryTree`
 * did, and see the same nodes in the same order for both audiences.
 */
const oid = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
const valid = [
	{ _id: oid(5), name: 'Leaf', slug: 'leaf', parent_id: oid(3), kind: 'product' },
	{ _id: oid(1), name: 'Root', slug: 'root', kind: 'group', order: 2 },
	{ _id: oid(3), name: 'Inner', slug: 'inner', kind: 'group', parent_id: oid(1) },
	{ _id: oid(2), name: 'Legacy', slug: 'legacy' },
	{ _id: oid(4), name: 'Hidden', slug: 'hidden', kind: 'group', status: 'draft' },
	{ _id: oid(6), name: 'Under hidden', slug: 'under', parent_id: oid(4) },
	{ _id: oid(7), name: 'Archived', slug: 'archived', status: 'archived' },
	{ _id: String(oid(8)), name: 'String id', slug: 'string-id', attribute_contract_version: 2 }
]
const ids = (items: { _id: string }[]) => items.map(item => item._id)

describe('buildTopology', () => {
	it('sees the nodes projectCategoryTree sees, in its order, for both audiences', () => {
		const topology = buildTopology(valid, 7)
		expect(topology.invalid).toBeNull()
		expect(ids(topology.all)).toEqual(ids(projectCategoryTree(valid, true)))
		expect(ids(topology.visible)).toEqual(ids(projectCategoryTree(valid, false)))
		expect(topology.byId.get(String(oid(5)))).toMatchObject({
			parent_id: String(oid(3)),
			visible: true,
			revision: 7,
			attribute_contract_version: 1
		})
		// The parent id is the parent's own string, not a copy.
		expect(topology.byId.get(String(oid(5)))!.parent_id).toBe(
			topology.byId.get(String(oid(3)))!._id
		)
		expect(topology.typed).toBe(true)
		expect(buildTopology([{ _id: oid(1), name: 'a', slug: 'a' }], 0).typed).toBe(false)
	})
	it.each([
		['bad kind', [{ _id: oid(1), name: 'a', slug: 'a', kind: 'leaf' }]],
		['bad status', [{ _id: oid(1), name: 'a', slug: 'a', status: 'gone' }]],
		['missing name', [{ _id: oid(1), slug: 'a' }]],
		['bad id', [{ _id: 'xyz', name: 'a', slug: 'a' }]],
		['bad order', [{ _id: oid(1), name: 'a', slug: 'a', order: -1 }]],
		[
			'duplicate id',
			[
				{ _id: oid(1), name: 'a', slug: 'a' },
				{ _id: oid(1), name: 'b', slug: 'b' }
			]
		],
		['unknown parent', [{ _id: oid(1), name: 'a', slug: 'a', parent_id: oid(9) }]],
		[
			'product parent',
			[
				{ _id: oid(1), name: 'a', slug: 'a' },
				{ _id: oid(2), name: 'b', slug: 'b', parent_id: oid(1) }
			]
		],
		[
			'cycle',
			[
				{ _id: oid(1), name: 'a', slug: 'a', kind: 'group', parent_id: oid(2) },
				{ _id: oid(2), name: 'b', slug: 'b', kind: 'group', parent_id: oid(1) }
			]
		]
	])('refuses what projectCategoryTree refused: %s', (_case, rows) => {
		expect(() => projectCategoryTree(rows, false)).toThrow()
		const topology = buildTopology(rows, 0)
		expect(topology.invalid).not.toBeNull()
		expect(topology.visible).toEqual([])
	})
	it('records an unknown contract version for the readers to refuse', () => {
		const topology = buildTopology(
			[{ _id: oid(1), name: 'a', slug: 'a', attribute_contract_version: 3 }],
			0
		)
		expect(topology.invalid).toBeNull()
		expect(topology.all[0].attribute_contract_version).toBeNull()
	})
})
