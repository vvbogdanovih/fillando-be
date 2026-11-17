import { createHash } from 'node:crypto'
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection } from 'mongoose'
import { CATEGORY_PAGE, CategoryOptionDto, CategoryTreeQueryDto } from './dto/category-tree.dto'
import type { CategoryTreeItem } from './category-tree-read'
import {
	categoryTopology,
	viewOf,
	type CategoryTopology,
	type TopologyNode
} from './category-topology'

/** A tree page item as the public tree has always returned it. */
const publicItem = (node: TopologyNode): CategoryTreeItem => ({
	_id: node._id,
	parent_id: node.parent_id,
	kind: node.kind,
	status: node.status,
	name: node.name,
	slug: node.slug,
	order: node.order
})
/** The admin tree additionally carries the contract version and the tile image. */
const adminItem = (node: TopologyNode): CategoryTreeItem => ({
	_id: node._id,
	attribute_contract_version: node.attribute_contract_version === 2 ? 2 : 1,
	image: node.image,
	parent_id: node.parent_id,
	kind: node.kind,
	status: node.status,
	name: node.name,
	slug: node.slug,
	order: node.order
})
const optionItem = (node: TopologyNode): CategoryOptionDto => ({
	_id: node._id,
	name: node.name,
	slug: node.slug,
	kind: 'product',
	attribute_contract_version: node.attribute_contract_version === 2 ? 2 : 1,
	order: node.order,
	image: node.image,
	attribute_count: node.attribute_count
})
/** A hash of the shaped items, fed item by item — never one string of the whole list. */
function snapshotOf<T>(nodes: TopologyNode[], shape: (node: TopologyNode) => T) {
	const hash = createHash('sha256')
	for (const node of nodes) hash.update(JSON.stringify(shape(node)))
	return hash.digest('hex')
}
interface View<T> {
	nodes: TopologyNode[]
	shape: (node: TopologyNode) => T
	snapshot: string
}
/** The public or admin tree of a topology: its nodes in `_id` order and their snapshot. */
const treeView = (topology: CategoryTopology, admin: boolean): View<CategoryTreeItem> =>
	viewOf(topology, admin ? 'tree:admin' : 'tree:public', () => {
		const nodes = admin ? topology.all : topology.visible
		const shape = admin ? adminItem : publicItem
		return { nodes, shape, snapshot: snapshotOf(nodes, shape) }
	})
/** The legacy list's product categories (visible, by order then ID) without their content. */
const optionsView = (topology: CategoryTopology): View<CategoryOptionDto> =>
	viewOf(topology, 'options', () => {
		const nodes = topology.visible
			.filter(node => node.kind === 'product')
			.sort((a, b) => a.order - b.order || a._id.localeCompare(b._id))
		return { nodes, shape: optionItem, snapshot: snapshotOf(nodes, optionItem) }
	})

@Injectable()
export class CategoryTreeReadService {
	/**
	 * Tree pages over the shared category topology (`category-topology.ts`): one read of every
	 * category per write or minute, shared with the public reader, instead of a projected copy per
	 * audience (Plan-0010 D06). Each page shapes only its own items.
	 */
	constructor(@InjectConnection() private readonly connection: Connection) {}
	private async stamp() {
		const control = await this.connection
			.db!.collection<{
				_id: string
				phase: string
				revision: number
				epoch: number
			}>('catalog_control')
			.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		if (!control) return { revision: 0, epoch: 0, initialized: false }
		if (
			control.phase !== 'idle' ||
			!Number.isSafeInteger(control.revision) ||
			!Number.isSafeInteger(control.epoch)
		)
			throw new ServiceUnavailableException({
				message: 'Catalog maintenance',
				details: { code: 'CATALOG_MAINTENANCE' }
			})
		return {
			revision: Number(control.revision),
			epoch: Number(control.epoch),
			initialized: true
		}
	}
	async read(query: CategoryTreeQueryDto, admin: boolean, parentId?: string | null) {
		const scope = parentId === undefined ? 'tree' : `children:${parentId ?? 'root'}`
		return this.page(query, admin, scope, topology => {
			const view = treeView(topology, admin)
			return {
				snapshot: view.snapshot,
				shape: view.shape,
				select: () => {
					if (parentId != null && !view.nodes.some(node => node._id === parentId))
						throw new NotFoundException('Category not found')
					return parentId === undefined
						? view.nodes
						: view.nodes
								.filter(node => node.parent_id === parentId)
								.sort((a, b) => a.order - b.order || a._id.localeCompare(b._id))
				}
			}
		})
	}
	/**
	 * `GET /categories/options` (Plan-0010 D06): the legacy list's categories without their
	 * content, paged like the tree — 17.7 MB at 10 000 categories as one list, ≤ 2 MiB a page here.
	 */
	async readOptions(query: CategoryTreeQueryDto) {
		return this.page(query, false, 'options', topology => {
			const view = optionsView(topology)
			return { snapshot: view.snapshot, shape: view.shape, select: () => view.nodes }
		})
	}
	private async page<T>(
		query: CategoryTreeQueryDto,
		admin: boolean,
		scope: string,
		view: (topology: CategoryTopology) => {
			snapshot: string
			shape: (node: TopologyNode) => T
			select: () => TopologyNode[]
		}
	) {
		const before = await this.stamp()
		let last = ''
		let expectedSnapshot: string | undefined
		if (query.cursor !== undefined) {
			let cursor: {
				revision: number
				epoch: number
				last: string
				admin: boolean
				snapshot: string
				scope: string
			}
			try {
				cursor = JSON.parse(
					Buffer.from(query.cursor, 'base64url').toString('utf8')
				) as typeof cursor
				if (
					!cursor ||
					!Number.isSafeInteger(cursor.revision) ||
					!Number.isSafeInteger(cursor.epoch) ||
					!/^[a-f0-9]{24}$/.test(cursor.last) ||
					cursor.admin !== admin ||
					cursor.scope !== scope ||
					!/^[a-f0-9]{64}$/.test(cursor.snapshot)
				)
					throw new Error()
			} catch {
				throw new BadRequestException('Invalid category cursor')
			}
			if (cursor.revision !== before.revision || cursor.epoch !== before.epoch)
				throw new ConflictException({
					message: 'Category tree changed; restart pagination',
					details: { code: 'CATEGORY_REVISION_CONFLICT' }
				})
			last = cursor.last
			expectedSnapshot = cursor.snapshot
		}
		const topology = await (await categoryTopology(this.connection, before)).topology
		if (!before.initialized && topology.typed)
			throw new ServiceUnavailableException('Catalog control is missing')
		if (topology.invalid) throw new ServiceUnavailableException('Category tree requires repair')
		const after = await this.stamp()
		if (JSON.stringify(before) !== JSON.stringify(after))
			throw new ServiceUnavailableException({
				message: 'Catalog changed during read',
				details: { code: 'CATALOG_READ_CHANGED' }
			})
		const { snapshot, shape, select } = view(topology)
		if (expectedSnapshot && expectedSnapshot !== snapshot)
			throw new ConflictException({
				message: 'Category tree changed; restart pagination',
				details: { code: 'CATEGORY_REVISION_CONFLICT' }
			})
		const selected = select()
		const lastIndex = last ? selected.findIndex(node => node._id === last) : -1
		if (last && lastIndex === -1) throw new BadRequestException('Invalid category cursor')
		const remaining = selected.length - (lastIndex + 1)
		const page = selected.slice(
			lastIndex + 1,
			lastIndex + 1 + (query.limit ?? CATEGORY_PAGE.default)
		)
		return {
			revision: before.revision,
			items: page.map(shape),
			next_cursor:
				remaining > page.length
					? Buffer.from(
							JSON.stringify({
								revision: before.revision,
								epoch: before.epoch,
								last: page.at(-1)!._id,
								snapshot,
								scope,
								admin
							})
						).toString('base64url')
					: null
		}
	}
}
