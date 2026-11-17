import { createHash } from 'node:crypto'
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import { z } from 'zod'
import { LegacyCatalogWritePolicy } from '../catalog-safety/legacy-catalog-write.interceptor'
import { parseDefinitions } from './attribute-definitions'
import { CATEGORY_PAGE } from './dto/category-tree.dto'
import type { CategoryTreeItem } from './category-tree-read'
import {
	categoryTopology,
	viewOf,
	type CategoryTopology,
	type TopologyNode
} from './category-topology'

const requiredSchema = z.array(
	z.object({
		key: z.string(),
		label: z.string(),
		filter_type: z.enum(['multi-select', 'range']),
		is_required: z.boolean(),
		unit: z.string().nullable().default(null)
	})
)
const seoSchema = z.object({
	title: z.string().nullable().default(null),
	description: z.string().nullable().default(null),
	h1: z.string().nullable().default(null),
	intro_html: z.string().nullable().default(null),
	bottom_html: z.string().nullable().default(null)
})

/** Public projection only: never spread raw Mongo documents or export settings. */
export function publicCategory(row: Record<string, unknown>, node: CategoryTreeItem) {
	const version = row.attribute_contract_version ?? 1
	if (version !== 1 && version !== 2) throw Error('INVALID_ATTRIBUTE_VERSION')
	return {
		...node,
		attribute_contract_version: version,
		image: z
			.string()
			.nullable()
			.parse(row.image ?? null),
		required_attributes:
			version === 1 ? requiredSchema.parse(row.required_attributes ?? []) : [],
		attribute_definitions: version === 2 ? parseDefinitions(row.attribute_definitions) : [],
		seo: seoSchema.parse(row.seo ?? {}),
		google_product_category:
			row.google_product_category == null
				? null
				: z
						.object({
							id: z.number().int().positive(),
							path: z.string()
						})
						.parse(row.google_product_category),
		...(row.createdAt == null ? {} : { createdAt: z.date().parse(row.createdAt) }),
		...(row.updatedAt == null ? {} : { updatedAt: z.date().parse(row.updatedAt) })
	}
}

/** A visible category with its content: what `GET /categories/:id` and the product page return. */
export type PublicTreeNode = ReturnType<typeof publicCategory> & {
	revision: number
	ancestors: { _id: string; name: string; slug: string }[]
	/**
	 * Present only past {@link ANCESTORS_EMBED_BYTES} (Plan-0010 D06.4): `ancestors` is then empty
	 * on purpose — never a silently shortened path — and the whole path is read page by page from
	 * `GET /categories/:id/ancestors`.
	 */
	ancestors_paged?: true
	ancestors_total?: number
}
/**
 * Ancestors embedded in a category or product detail at most this large (JSON bytes); a deeper path
 * is marked and paged instead, so no detail passes 2 MiB. Any real depth stays far below — ~2 000
 * levels with 200-character names, ~11 000 with short ones.
 */
export const ANCESTORS_EMBED_BYTES = 1024 * 1024
/**
 * A visible category without its content (Plan-0010 D06): topology, identity and the attribute
 * contract — what lists, scopes, visibility checks and the sitemap need. The memo holds only
 * these; definitions and SEO are read per category ({@link CategoryPublicReadService.contentOf}).
 */
export type PublicCategoryNode = TopologyNode & { attribute_contract_version: 1 | 2 }
/** A changed placement between the two passes of a parse: the reader's «retry». */
const changed = () =>
	new ServiceUnavailableException({
		message: 'Каталог тимчасово оновлюється. Спробуйте ще раз за кілька секунд.',
		details: { code: 'CATALOG_READ_CHANGED' }
	})
const repair = () =>
	new ServiceUnavailableException({
		message: 'Category data requires repair',
		details: { code: 'CATALOG_CATEGORY_DATA_UNAVAILABLE' }
	})

type Ancestor = { _id: string; name: string; slug: string }

/** The visible tree of one memo: nodes in the public order and the indexes over them. */
interface Topology {
	nodes: PublicCategoryNode[]
	products: PublicCategoryNode[]
	/** Visible nodes by id (the shared index, hidden ones answered as absent). */
	byId: { get(id: string): PublicCategoryNode | undefined }
	bySlug: Map<string, PublicCategoryNode>
}
/** A node's ancestors, root first, from the memo's topology: O(depth). */
function ancestorsOf(topology: Topology, node: PublicCategoryNode): Ancestor[] {
	const ancestors: Ancestor[] = []
	for (let parent = node.parent_id; parent !== null; ) {
		const ancestor = topology.byId.get(parent)!
		ancestors.push({ _id: ancestor._id, name: ancestor.name, slug: ancestor.slug })
		parent = ancestor.parent_id
	}
	return ancestors.reverse()
}
/**
 * The public reader's view of the shared topology: the visible nodes in the public order (order,
 * then ID), checked as the reader always checked them — any invalid stored category, a visible
 * duplicate slug or contract version — and nothing copied.
 */
const readerView = (topology: CategoryTopology): Topology =>
	viewOf(topology, 'public-reader', () => {
		if (topology.invalid) throw repair()
		const nodes = [...topology.visible].sort(
			(a, b) => a.order - b.order || a._id.localeCompare(b._id)
		) as PublicCategoryNode[]
		const bySlug = new Map<string, PublicCategoryNode>()
		for (const node of nodes) {
			if (node.attribute_contract_version === null || bySlug.has(node.slug)) throw repair()
			bySlug.set(node.slug, node)
		}
		return {
			nodes,
			products: nodes.filter(node => node.kind === 'product'),
			byId: {
				get: (id: string) => {
					const node = topology.byId.get(id)
					return node?.visible ? (node as PublicCategoryNode) : undefined
				}
			},
			bySlug
		}
	})
/** Parsed categories kept per memo, most recently used first out last (Plan-0010 D06). */
export const CATEGORY_CONTENT_CACHE = 500
interface Memo {
	/** The shared topology this memo is a view of. */
	source: Promise<CategoryTopology>
	topology: Promise<Topology>
	/** Parsed content by id, insertion order = least recently used first; bounded. */
	content: Map<string, Promise<PublicTreeNode>>
}

/**
 * One memo per connection, shared by every reader instance (CategoryModule, the partner API and
 * the sitemap each get their own from Nest), over the one topology the tree pages use too
 * (`category-topology.ts`): one read after a write, not one per module or audience (Plan-0010 D06).
 */
const memos = new WeakMap<Connection, { memo: Memo | null }>()
/** The memo key a returned node list was built under (see `keyOf`). */
const keys = new WeakMap<PublicCategoryNode[], string>()
/** The memo a returned node list belongs to (see `contentOf`'s `of`). */
const owners = new WeakMap<PublicCategoryNode[], Memo>()
/** The ids of a returned node list, built when `contentOf` is first scoped to it. */
const members = new WeakMap<PublicCategoryNode[], Set<string>>()
const membersOf = (list: PublicCategoryNode[]) => {
	let ids = members.get(list)
	if (!ids) members.set(list, (ids = new Set(list.map(node => node._id))))
	return ids
}
const CONTENT = {
	_id: 1,
	parent_id: 1,
	kind: 1,
	status: 1,
	name: 1,
	slug: 1,
	order: 1,
	attribute_contract_version: 1,
	attribute_definitions: 1,
	required_attributes: 1,
	image: 1,
	seo: 1,
	google_product_category: 1,
	createdAt: 1,
	updatedAt: 1
}
const CONTENT_BATCH = 1000

@Injectable()
export class CategoryPublicReadService {
	/**
	 * The visible tree without content, over the shared category topology (keyed by the catalogue
	 * stamp plus an O(1) write mark of `categories`, so any write invalidates it; reused at most
	 * `CATEGORY_MEMO_MS`). Content is parsed per category on demand and kept for at most
	 * `CATEGORY_CONTENT_CACHE` categories of the memo: the memo of 10 000 parsed categories held
	 * tens of MiB of duplicated definition strings, ~730 MiB at 150 000 (Plan-0010 D06). A server
	 * without a fingerprint reads every time. Callers get shared objects — never mutate them.
	 */
	private get state() {
		let state = memos.get(this.connection)
		if (!state) memos.set(this.connection, (state = { memo: null }))
		return state
	}
	constructor(@InjectConnection() private readonly connection: Connection) {}
	/** Runs `read` over the current memo inside the catalogue read barrier. */
	private async withMemo<T>(
		read: (
			memo: Memo,
			topology: Topology,
			stamp: { revision: number; epoch: number; initialized: boolean }
		) => Promise<T>
	): Promise<T> {
		const policy = new LegacyCatalogWritePolicy(this.connection)
		const stamp = await policy.beginRead(true)
		const { key, topology } = await categoryTopology(this.connection, stamp)
		const memo = this.memo(topology, key)
		const result = await read(memo, await memo.topology, stamp)
		await policy.finishRead(stamp, true)
		return result
	}
	/** The memo over this topology: the same one while the shared topology holds. */
	private memo(source: Promise<CategoryTopology>, key: string | null): Memo {
		const state = this.state
		if (state.memo?.source === source) return state.memo
		const memo: Memo = {
			source,
			topology: source.then(readerView),
			content: new Map()
		}
		if (key !== null) {
			state.memo = memo
			memo.topology.catch(() => {
				if (state.memo === memo) state.memo = null
			})
			memo.topology.then(topology => keys.set(topology.nodes, key)).catch(() => undefined)
		}
		memo.topology
			.then(topology => {
				owners.set(topology.nodes, memo)
				owners.set(topology.products, memo)
			})
			.catch(() => undefined)
		return memo
	}
	/**
	 * The full public category for each visible id — the cached ones from the memo, the others read
	 * in batches and checked against the memo's placement (a category moved, renamed or hidden
	 * since is the read barrier's «retry»). `cache: false` for a bulk pass (the feed, the legacy
	 * list) that must not evict what the storefront keeps reading.
	 */
	private async content(
		memo: Memo,
		topology: Topology,
		ids: Iterable<string>,
		cache: boolean
	): Promise<Map<string, PublicTreeNode>> {
		const found = new Map<string, Promise<PublicTreeNode>>()
		const missing = new Map<string, PublicCategoryNode>()
		for (const id of ids) {
			if (found.has(id) || missing.has(id)) continue
			const node = topology.byId.get(id)
			if (!node) continue
			const cached = cache ? memo.content.get(id) : undefined
			if (cached) {
				// Most recently used: to the end of the insertion order.
				memo.content.delete(id)
				memo.content.set(id, cached)
				found.set(id, cached)
			} else missing.set(id, node)
		}
		const pending = [...missing.values()]
		for (let at = 0; at < pending.length; at += CONTENT_BATCH) {
			const batch = pending.slice(at, at + CONTENT_BATCH)
			const parsed = this.parseContent(topology, batch)
			parsed.catch(() => undefined)
			for (const node of batch) {
				const one = parsed.then(rows => rows.get(node._id)!)
				// Awaited below one by one: a failed batch must not leave the rest unhandled.
				one.catch(() => undefined)
				found.set(node._id, one)
				if (!cache) continue
				memo.content.set(node._id, one)
				one.catch(() => {
					if (memo.content.get(node._id) === one) memo.content.delete(node._id)
				})
				if (memo.content.size > CATEGORY_CONTENT_CACHE)
					memo.content.delete(memo.content.keys().next().value as string)
			}
		}
		const result = new Map<string, PublicTreeNode>()
		for (const [id, node] of found) result.set(id, await node)
		return result
	}
	private async parseContent(topology: Topology, batch: PublicCategoryNode[]) {
		const parsed = new Map<string, PublicTreeNode>()
		for await (const row of this.connection
			.collection('categories')
			.find(
				{ _id: { $in: batch.map(node => new mongo.ObjectId(node._id)) } },
				{ readPreference: 'primary', projection: CONTENT, batchSize: CONTENT_BATCH }
			)) {
			const node = topology.byId.get(String(row._id))!
			if (
				String(row.parent_id ?? null) !== String(node.parent_id) ||
				(row.kind ?? 'product') !== node.kind ||
				(row.status ?? 'active') !== node.status ||
				row.name !== node.name ||
				row.slug !== node.slug ||
				(row.order ?? 0) !== node.order ||
				(row.attribute_contract_version ?? 1) !== node.attribute_contract_version
			)
				throw changed()
			let category: PublicTreeNode
			try {
				// The tree item's own fields, in its order: responses stay byte for byte the same.
				const base: CategoryTreeItem = {
					_id: node._id,
					parent_id: node.parent_id,
					kind: node.kind,
					status: node.status,
					name: node.name,
					slug: node.slug,
					order: node.order
				}
				category = {
					...publicCategory(row, base),
					revision: node.revision
				} as PublicTreeNode
			} catch {
				throw repair()
			}
			// Last, as the lazy getter used to put it: the same key order, the same bytes.
			const ancestors = ancestorsOf(topology, node)
			if (Buffer.byteLength(JSON.stringify(ancestors)) <= ANCESTORS_EMBED_BYTES)
				category.ancestors = ancestors
			else
				Object.assign(category, {
					ancestors: [],
					ancestors_paged: true,
					ancestors_total: ancestors.length
				})
			parsed.set(node._id, category)
		}
		if (parsed.size !== batch.length) throw changed()
		return parsed
	}

	/**
	 * Every visible product category with its content — the legacy `GET /categories`, kept as it
	 * was for the storefront released before Plan-0010 until R04. Parsed per call in batches, never
	 * memoised: new readers use `GET /categories/options` and one category by id.
	 */
	async findAll(): Promise<PublicTreeNode[]> {
		return this.withMemo(async (memo, topology) => {
			const content = await this.content(
				memo,
				topology,
				topology.products.map(node => node._id),
				false
			)
			return topology.products.map(node => content.get(node._id)!)
		})
	}
	/** Every visible node, groups included, without content — navigation, scopes, sitemap. */
	async findVisibleTree(): Promise<PublicCategoryNode[]> {
		return this.withMemo((_memo, topology) => Promise.resolve(topology.nodes))
	}
	/** Visible product categories without content — visibility checks and select lists. */
	async productCategories(): Promise<PublicCategoryNode[]> {
		return this.withMemo((_memo, topology) => Promise.resolve(topology.products))
	}
	/**
	 * Visible categories by id with their content; ids that are not visible are absent. A bulk
	 * pass (`cache: false`) reads past the bounded cache instead of evicting it. `of`: a list this
	 * reader returned — only its members are answered (product categories for
	 * `productCategories()`), read against that same tree (a category changed since is the
	 * «retry») inside the caller's own read barrier, as one parse used to serve both.
	 */
	async contentOf(
		ids: Iterable<string>,
		options: { cache?: boolean; of?: PublicCategoryNode[] } = {}
	): Promise<Map<string, PublicTreeNode>> {
		const of = options.of
		const wanted = of ? [...ids].filter(id => membersOf(of).has(id)) : ids
		const memo = of && owners.get(of)
		if (memo) return this.content(memo, await memo.topology, wanted, options.cache ?? true)
		return this.withMemo((current, topology) =>
			this.content(current, topology, wanted, options.cache ?? true)
		)
	}
	/**
	 * The stamp-and-content key a `findVisibleTree()` / `productCategories()` result was read under,
	 * or `null` (no memo on this server). Lets a caller key its own derived caches on the same read
	 * instead of fingerprinting the categories a second time per request.
	 */
	keyOf(nodes: PublicCategoryNode[]): string | null {
		return keys.get(nodes) ?? null
	}
	/** A visible node (group or product) by id with its content, or undefined. */
	async findVisibleById(id: string): Promise<PublicTreeNode | undefined> {
		return (await this.contentOf([id])).get(id)
	}
	async findById(id: string): Promise<PublicTreeNode> {
		const category = await this.withMemo(async (memo, topology) => {
			// The memo keys lower-case hex, as `new ObjectId()` writes it; an ObjectId in upper case
			// is the same id and answered 200 through the Mongoose cast before (audit 11.11).
			const node = topology.byId.get(id.toLowerCase())
			return node && (await this.content(memo, topology, [node._id], true)).get(node._id)
		})
		if (!category) throw new NotFoundException('Category not found')
		return category
	}
	/**
	 * A visible category's ancestors, root first, a page at a time (Plan-0010 D06.4) — the whole
	 * path of a category whose detail marks it `ancestors_paged`. The cursor is bound to the
	 * catalogue revision and to the path itself: either changing restarts the walk (409).
	 */
	async ancestorsPage(id: string, query: { limit?: number; cursor?: string }) {
		const page = await this.withMemo((_memo, topology, stamp) => {
			const node = topology.byId.get(id)
			if (!node) return Promise.resolve(null)
			const ancestors = ancestorsOf(topology, node)
			const snapshot = createHash('sha256').update(JSON.stringify(ancestors)).digest('hex')
			let offset = 0
			if (query.cursor !== undefined) {
				let cursor: {
					revision: number
					epoch: number
					id: string
					offset: number
					path: string
				}
				try {
					cursor = JSON.parse(
						Buffer.from(query.cursor, 'base64url').toString('utf8')
					) as typeof cursor
					if (
						!cursor ||
						cursor.id !== id ||
						!Number.isSafeInteger(cursor.revision) ||
						!Number.isSafeInteger(cursor.epoch) ||
						!Number.isSafeInteger(cursor.offset) ||
						cursor.offset < 1 ||
						typeof cursor.path !== 'string'
					)
						throw Error()
				} catch {
					throw new BadRequestException('Invalid ancestors cursor')
				}
				if (
					cursor.revision !== stamp.revision ||
					cursor.epoch !== stamp.epoch ||
					cursor.path !== snapshot ||
					cursor.offset >= ancestors.length
				)
					throw new ConflictException({
						message: 'Category tree changed; restart pagination',
						details: { code: 'CATEGORY_REVISION_CONFLICT' }
					})
				offset = cursor.offset
			}
			const limit = Math.min(query.limit ?? CATEGORY_PAGE.default, CATEGORY_PAGE.max)
			const items = ancestors.slice(offset, offset + limit)
			const end = offset + items.length
			return Promise.resolve({
				revision: stamp.revision,
				total: ancestors.length,
				items,
				next_cursor:
					end < ancestors.length
						? Buffer.from(
								JSON.stringify({
									revision: stamp.revision,
									epoch: stamp.epoch,
									id,
									offset: end,
									path: snapshot
								})
							).toString('base64url')
						: null
			})
		})
		if (!page) throw new NotFoundException('Category not found')
		return page
	}
	async findBySlug(slug: string): Promise<PublicTreeNode> {
		const category = await this.withMemo(async (memo, topology) => {
			const node = topology.bySlug.get(slug)
			return node && (await this.content(memo, topology, [node._id], true)).get(node._id)
		})
		if (!category) throw new NotFoundException('Category not found')
		return category
	}
}
