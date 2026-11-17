/**
 * FROZEN copy of `CategoryPublicReadService` as it was before Plan-0010 D06.3 (light memo, 2026-10-30).
 * Used only by `category-public-read-parity.int-spec.ts` as the reference the new reader must
 * match byte for byte; never import it from application code. Delete together with that spec.
 */
import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection } from 'mongoose'
import { z } from 'zod'
import { LegacyCatalogWritePolicy } from '../../catalog-safety/legacy-catalog-write.interceptor'
import { parseDefinitions } from '../attribute-definitions'
import { projectCategoryTree, CategoryTreeItem } from '../category-tree-read'
import { CATEGORY_MEMO_MS, categoryFingerprint } from '../category-fingerprint'

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
function publicCategory(row: Record<string, unknown>, node: CategoryTreeItem) {
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

type PublicTreeNode = ReturnType<typeof publicCategory> & {
	revision: number
	ancestors: { _id: string; name: string; slug: string }[]
}
/** A changed placement between the two passes of a parse: the reader's «retry». */
const changed = () =>
	new ServiceUnavailableException({
		message: 'Каталог тимчасово оновлюється. Спробуйте ще раз за кілька секунд.',
		details: { code: 'CATALOG_READ_CHANGED' }
	})

type Ancestor = { _id: string; name: string; slug: string }

/**
 * The parsed tree is shared by every reader instance on a connection (CategoryModule, the partner
 * API and the sitemap each get their own instance from Nest): one copy of 10 000 parsed categories,
 * one parse after a write, not one per module (Plan-0010 D06).
 */
const memos = new WeakMap<
	Connection,
	{ memo: { key: string; at: number; nodes: Promise<PublicTreeNode[]> } | null }
>()
/** The memo key a returned `findVisibleTree()` list was built under (see `keyOf`). */
const keys = new WeakMap<PublicTreeNode[], string>()
/** Visible nodes by id, per parsed list (`findVisibleById`). */
const indexes = new WeakMap<PublicTreeNode[], Map<string, PublicTreeNode>>()
const TOPOLOGY = { _id: 1, parent_id: 1, kind: 1, status: 1, name: 1, slug: 1, order: 1 }
const CONTENT = {
	...TOPOLOGY,
	attribute_contract_version: 1,
	attribute_definitions: 1,
	required_attributes: 1,
	image: 1,
	seo: 1,
	google_product_category: 1,
	createdAt: 1,
	updatedAt: 1
}

@Injectable()
export class FormerCategoryPublicReadService {
	/**
	 * Every visible node, parsed, keyed by the catalogue stamp plus `categoryFingerprint`, so any
	 * write invalidates it. On 10 000 categories each read re-parsed every definition list and a
	 * catalogue request read twice: ~0.85 s before any SKU was touched (Plan-0010 large-catalogue
	 * load). A server without the fingerprint operator just parses every time. Callers get the
	 * shared objects — never mutate them.
	 */
	private get state() {
		let state = memos.get(this.connection)
		if (!state) memos.set(this.connection, (state = { memo: null }))
		return state
	}
	constructor(@InjectConnection() private readonly connection: Connection) {}
	private async fingerprint(stamp: { revision: number; epoch: number; initialized: boolean }) {
		const content = await categoryFingerprint(this.connection)
		return content === null
			? null
			: JSON.stringify([stamp.initialized, stamp.revision, stamp.epoch, content])
	}
	async read(selector?: { id: string } | { slug: string } | { all: true }) {
		const policy = new LegacyCatalogWritePolicy(this.connection)
		const stamp = await policy.beginRead(true)
		const key = await this.fingerprint(stamp)
		const nodes = await this.nodes(stamp.revision, key)
		const selected =
			selector && 'all' in selector
				? nodes
				: selector
					? nodes.filter(node =>
							'id' in selector
								? node._id === selector.id
								: node.slug === selector.slug
						)
					: nodes.filter(node => node.kind === 'product')
		await policy.finishRead(stamp, true)
		if (selector && !('all' in selector) && !selected.length)
			throw new NotFoundException('Category not found')
		return selected
	}
	/**
	 * The memoised parse, or one parse shared by every concurrent request that missed it: when
	 * the memo expired under 10 concurrent catalogue reads, each parsed its own copy of 10 000
	 * categories and the API ran out of a 400 MB heap (Plan-0010 D06, 29.10).
	 */
	private nodes(revision: number, key: string | null) {
		const state = this.state
		if (
			key !== null &&
			state.memo?.key === key &&
			Date.now() - state.memo.at < CATEGORY_MEMO_MS
		)
			return state.memo.nodes
		const parsing = this.parse(revision, key)
		if (key !== null) {
			const memo = { key, at: Date.now(), nodes: parsing }
			state.memo = memo
			parsing.catch(() => {
				if (state.memo === memo) state.memo = null
			})
		}
		return parsing
	}
	/**
	 * Two passes, so the documents never sit in memory all at once (~100 MiB at 10 000
	 * categories, per parse): the topology of every category, then the content of the visible
	 * ones in batches. A category whose placement changed between the passes (a raw write that
	 * bumped no revision) is the read barrier's «catalogue changed» — retry — never a mix.
	 * `ancestors` is computed when read: eagerly it was O(nodes × depth) — 2·10⁸ entries for a
	 * 20 000-level chain (TD-0013 §6 stress).
	 */
	private async parse(revision: number, key: string | null): Promise<PublicTreeNode[]> {
		const categories = this.connection.collection('categories')
		const rows = await categories
			.find({}, { readPreference: 'primary', projection: TOPOLOGY })
			.toArray()
		try {
			const visible = projectCategoryTree(rows, false)
			if (new Set(visible.map(node => node.slug)).size !== visible.length)
				throw Error('DUPLICATE_CATEGORY_SLUG')
			const byId = new Map(visible.map(node => [node._id, node]))
			const parsed = new Map<string, PublicTreeNode>()
			const ancestorsOf = (node: CategoryTreeItem) => {
				const ancestors: Ancestor[] = []
				for (let parent = node.parent_id; parent !== null; ) {
					const ancestor = byId.get(parent)!
					ancestors.push({ _id: ancestor._id, name: ancestor.name, slug: ancestor.slug })
					parent = ancestor.parent_id
				}
				return ancestors.reverse()
			}
			const ids = rows.filter(row => byId.has(String(row._id))).map(row => row._id)
			for await (const row of categories.find(
				{ _id: { $in: ids } },
				{ readPreference: 'primary', projection: CONTENT, batchSize: 1000 }
			)) {
				const node = byId.get(String(row._id))!
				if (
					String(row.parent_id ?? null) !== String(node.parent_id) ||
					(row.kind ?? 'product') !== node.kind ||
					(row.status ?? 'active') !== node.status ||
					row.name !== node.name ||
					row.slug !== node.slug ||
					(row.order ?? 0) !== node.order
				)
					throw changed()
				let ancestors: Ancestor[] | undefined
				const category = { ...publicCategory(row, node), revision } as PublicTreeNode
				Object.defineProperty(category, 'ancestors', {
					enumerable: true,
					get: () => (ancestors ??= ancestorsOf(node))
				})
				parsed.set(node._id, category)
			}
			if (parsed.size !== visible.length) throw changed()
			const result = [...parsed.values()].sort(
				(a, b) => a.order - b.order || a._id.localeCompare(b._id)
			)
			if (key !== null) keys.set(result, key)
			return result
		} catch (error) {
			if (error instanceof NotFoundException || error instanceof ServiceUnavailableException)
				throw error
			throw new ServiceUnavailableException({
				message: 'Category data requires repair',
				details: { code: 'CATALOG_CATEGORY_DATA_UNAVAILABLE' }
			})
		}
	}
	async findAll() {
		return this.read()
	}
	/** Every visible node, groups included — navigation and sitemap, not the v1 list. */
	async findVisibleTree() {
		return this.read({ all: true })
	}
	/**
	 * The stamp-and-content key a `findVisibleTree()` result was read under, or `null` (no memo on
	 * this server). Lets a caller key its own derived caches on the same read instead of hashing
	 * the categories a second time per request.
	 */
	keyOf(nodes: PublicTreeNode[]): string | null {
		return keys.get(nodes) ?? null
	}
	/** A visible node (group or product) by id, or undefined — without copying the list. */
	async findVisibleById(id: string) {
		const nodes = await this.findVisibleTree()
		let index = indexes.get(nodes)
		if (!index) indexes.set(nodes, (index = new Map(nodes.map(node => [node._id, node]))))
		return index.get(id)
	}
	async findById(id: string) {
		return (await this.read({ id }))[0]
	}
	async findBySlug(slug: string) {
		return (await this.read({ slug }))[0]
	}
}
