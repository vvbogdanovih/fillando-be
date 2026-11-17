import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mongo } from 'mongoose'
import { z } from 'zod'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { readCategoryConfiguration } from './category-configuration'
import { parseDefinitions } from './attribute-definitions'
import { projectCategoryTree } from './category-tree-read'
import {
	definitionsInputSchema,
	resolveDefinitions,
	DefinitionInput
} from './category-definition-editor'
import { CategoryTree } from './category-tree'
import {
	normalizeCatalogPath,
	reservedCategorySlug
} from 'src/modules/catalog-routes/catalog-route-plan'
import {
	assertDataStaysValid,
	CategoryData,
	checkDefinitionChange,
	definitionUsage
} from './category-definition-change'

const id = z.string().regex(/^[a-f0-9]{24}$/)
const placementSchema = z.strictObject({
	id,
	parent_id: id.nullable(),
	order: z.number().int().nonnegative().safe()
})
const creationSchema = z.strictObject({
	id,
	parent_id: id.nullable(),
	order: z.number().int().nonnegative().safe(),
	name: z.string().trim().min(1).max(200),
	slug: z
		.string()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(200),
	kind: z.enum(['group', 'product']),
	attribute_definitions: z.array(z.unknown())
})
/** A tile image is an uploaded public URL (S3), as for typed landings. */
export const categoryImageSchema = z.string().url().max(2000).nullable()
export type CategoryPlacement = z.infer<typeof placementSchema>
export type CategoryCreation = z.infer<typeof creationSchema>
export interface CategoryWriteRequest {
	operationId: string
	ownerId: string
	expectedRevision: number
	requireDraftWrites?: boolean
}

/** What `snapshot` keeps of a category other than the target: what plans and the projection read. */
const SNAPSHOT_FIELDS = [
	'_id',
	'parent_id',
	'kind',
	'status',
	'name',
	'slug',
	'order',
	'attribute_contract_version',
	'image'
] as const

/** A v2 category whose content the new admin may edit: a draft or a published one. */
/**
 * A name or address another category already has (P01, owner decision 02.11.2026): the admin is
 * told which category and which of the two collided, not just that something did. The message is
 * the code, so callers matching on it keep working.
 */
export class CategoryIdentityConflict extends Error {
	readonly conflict: {
		field: 'name' | 'slug'
		category: { id: string; name: string; slug: string }
	}
	constructor(field: 'name' | 'slug', row: mongo.WithId<mongo.Document>) {
		super('CATEGORY_IDENTITY_CONFLICT')
		this.conflict = {
			field,
			category: { id: String(row._id), name: String(row.name), slug: String(row.slug) }
		}
	}
}

function editable(rows: mongo.WithId<mongo.Document>[], categoryId: string) {
	const row = rows.find(row => String(row._id) === categoryId)
	if (!row) throw Error('CATEGORY_NOT_FOUND')
	if (row.attribute_contract_version !== 2) throw Error('CATALOG_CONTRACT_UPGRADE_REQUIRED')
	if (row.status !== 'draft' && row.status !== 'active') throw Error('CATEGORY_ARCHIVED')
	return row
}

/** Products, SKUs and typed landings of one category, read from the primary under the gate. */
export async function readCategoryData(db: mongo.Db, categoryId: string): Promise<CategoryData> {
	const ids = [categoryId, new mongo.ObjectId(categoryId)]
	const read = { readPreference: 'primary' as const }
	const [products, variants, landings] = await Promise.all([
		db
			.collection('products')
			.find(
				{ category_id: { $in: ids } },
				{ ...read, projection: { attributes_v2: 1, variant_axis: 1 } }
			)
			.toArray(),
		db
			.collection('product_variants')
			.find(
				{ category_id: { $in: ids } },
				{ ...read, projection: { product_id: 1, variant_value: 1 } }
			)
			.toArray(),
		db
			.collection('landings')
			.find(
				{ category_id: { $in: ids }, contract_version: 2 },
				{ ...read, projection: { filters_v2: 1 } }
			)
			.toArray()
	])
	return {
		products: products.map(row => ({
			id: String(row._id),
			attributes_v2: row.attributes_v2 as unknown,
			variant_axis: row.variant_axis as unknown
		})),
		variants: variants.map(row => ({
			id: String(row._id),
			product_id: String(row.product_id),
			variant_value: row.variant_value as unknown
		})),
		landings: landings.map(row => ({
			id: String(row._id),
			filters_v2: row.filters_v2 as unknown
		}))
	}
}

/** Journal coordinator for the new admin's category writes (tree, definitions, details). */
export class CategoryTreeWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate)
	}
	/**
	 * Every category validated, the tree projected — keeping only the fields the plans compare
	 * (identity, placement, kind, status) of every row and the whole document of `targetId` alone.
	 * Streamed: holding all documents cost ~100 MiB per snapshot at 10 000 categories, twice per
	 * operation, and moves ran a 400 MB heap out of memory (Plan-0010 D06, 29.10).
	 */
	private async snapshot(targetId?: string) {
		const rows: mongo.WithId<mongo.Document>[] = []
		for await (const row of this.db
			.collection('categories')
			.find({}, { readPreference: 'primary', batchSize: 1000 })) {
			readCategoryConfiguration({
				...row,
				parent_id: row.parent_id == null ? null : String(row.parent_id)
			})
			rows.push(
				String(row._id) === targetId
					? row
					: (Object.fromEntries(
							SNAPSHOT_FIELDS.filter(key => Object.hasOwn(row, key)).map(key => [
								key,
								row[key]
							])
						) as mongo.WithId<mongo.Document>)
			)
		}
		const items = projectCategoryTree(rows, true)
		const tree = new CategoryTree(
			items.map(item => ({ id: item._id, parent_id: item.parent_id, kind: item.kind }))
		)
		return { rows, items, tree }
	}
	private async run(
		request: CategoryWriteRequest,
		command: object,
		categoryId: string,
		plan: (
			snapshot: Awaited<ReturnType<CategoryTreeWriter['snapshot']>>
		) => CatalogPatch | Promise<CatalogPatch>
	) {
		const hash = createHash('sha256')
			.update(mongo.BSON.serialize({ expected_revision: request.expectedRevision, command }))
			.digest('hex')
		const previous = await this.gate.operation(request.operationId)
		if (previous) {
			if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			if (previous.status === 'completed' && previous.revision !== undefined)
				return {
					operation_id: request.operationId,
					revision: previous.revision,
					category_id: categoryId
				}
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}

		const token = await this.gate.acquire(
			request.operationId,
			hash,
			request.ownerId,
			request.expectedRevision
		)
		let executionStarted = false
		try {
			if (request.requireDraftWrites) {
				const enabled = await this.db
					.collection<{ _id: string }>('catalog_control')
					.findOne({ _id: 'catalog', admin_draft_writes_enabled: true })
				if (!enabled) throw Error('CATALOG_DRAFT_WRITES_DISABLED')
			}
			const patch = await plan(await this.snapshot(categoryId))
			await this.journal.prepare(token, [patch])
			executionStarted = true
			await this.journal.execute(token, 'apply')
			await this.snapshot()
			const inspection = await this.journal.inspect(request.operationId)
			if (inspection.counts.after + inspection.counts.both !== 1)
				throw Error('CATEGORY_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			return {
				operation_id: request.operationId,
				revision: token.revision + 1,
				category_id: categoryId
			}
		} catch (error) {
			// After the first domain write, the gate stays closed (recovery_required) for the
			// operator recovery CLI; a refusal before it releases the gate.
			try {
				await this.gate.afterFailedWrite(token, executionStarted)
			} catch (abortError) {
				throw new AggregateError([error, abortError], 'CATEGORY_ABORT_FAILED')
			}
			throw error
		}
	}
	async move(request: CategoryWriteRequest, input: CategoryPlacement) {
		return this.place(request, input, false)
	}
	async moveDraft(request: CategoryWriteRequest, input: CategoryPlacement) {
		return this.place(request, input, true)
	}
	private async place(
		request: CategoryWriteRequest,
		input: CategoryPlacement,
		draftOnly: boolean
	) {
		const value = placementSchema.parse(input)
		return this.run(
			request,
			{ type: draftOnly ? 'draft-placement' : 'placement', ...value },
			value.id,
			async ({ rows, tree, items }) => {
				const row = rows.find(row => String(row._id) === value.id)
				if (!row) throw Error('CATEGORY_NOT_FOUND')
				if (row.attribute_contract_version !== 2)
					throw Error('CATALOG_CONTRACT_UPGRADE_REQUIRED')
				if (draftOnly) {
					const enabled = await this.db
						.collection<{ _id: string }>('catalog_control')
						.findOne({ _id: 'catalog', admin_draft_writes_enabled: true })
					if (!enabled) throw Error('CATALOG_DRAFT_WRITES_DISABLED')
					if (row.status === 'archived') throw Error('CATEGORY_ARCHIVED')
					// A published branch moves with its storefront visibility intact: only under a
					// public group or to the root (an active node always has an active parent, so a
					// draft node heads a draft-only branch, which may go anywhere). Category, landing
					// and product addresses do not depend on the tree — a move changes menus and
					// breadcrumbs, never a URL, SKU or Merchant id.
					if (row.status === 'active' && value.parent_id !== null) {
						const parent = items.find(item => item._id === value.parent_id)
						if (parent && parent.status !== 'active')
							throw Error('CATEGORY_PARENT_NOT_PUBLIC')
					}
				}
				tree.assertMove(value.id, value.parent_id)
				const fields: CatalogPatch['fields'] = {}
				for (const [key, after] of Object.entries({
					parent_id:
						value.parent_id === null ? null : new mongo.ObjectId(value.parent_id),
					order: value.order
				})) {
					fields[key] = {
						before: Object.hasOwn(row, key)
							? { exists: true, value: row[key] }
							: { exists: false },
						after: { exists: true, value: after }
					}
				}
				return { collection: 'categories', id: value.id, fields }
			}
		)
	}
	/** Explicit conversion of an unused draft; populated categories need a separate migration. */
	async convertDraft(
		request: CategoryWriteRequest,
		input: {
			id: string
			kind: 'group' | 'product'
			attribute_definitions: unknown[]
		}
	) {
		const value = z
			.strictObject({
				id,
				kind: z.enum(['group', 'product']),
				attribute_definitions: z.array(z.unknown())
			})
			.parse(input)
		const definitions = parseDefinitions(value.attribute_definitions)
		if (value.kind === 'group' && definitions.length) throw Error('GROUP_ATTRIBUTES')
		return this.run(
			request,
			{ type: 'convert-draft', ...value, attribute_definitions: definitions },
			value.id,
			async ({ rows, items }) => {
				const row = rows.find(row => String(row._id) === value.id)
				if (!row) throw Error('CATEGORY_NOT_FOUND')
				if (row.attribute_contract_version !== 2)
					throw Error('CATALOG_CONTRACT_UPGRADE_REQUIRED')
				if (row.status !== 'draft') throw Error('CATEGORY_CONVERSION_REQUIRES_DRAFT')
				if (row.kind === value.kind) throw Error('CATEGORY_KIND_UNCHANGED')
				if (items.some(item => item.parent_id === value.id)) throw Error('CATEGORY_IN_USE')
				const ids = [new mongo.ObjectId(value.id), value.id]
				for (const collection of ['products', 'product_variants', 'landings']) {
					if (
						await this.db
							.collection(collection)
							.findOne(
								{ category_id: { $in: ids } },
								{ projection: { _id: 1 }, readPreference: 'primary' }
							)
					)
						throw Error('CATEGORY_IN_USE')
				}
				const fields: CatalogPatch['fields'] = {}
				for (const [key, after] of Object.entries({
					kind: value.kind,
					attribute_definitions: definitions
				}))
					fields[key] = {
						before: { exists: true, value: row[key] },
						after: { exists: true, value: after }
					}
				return { collection: 'categories', id: value.id, fields }
			}
		)
	}

	/** Published categories require archive/redirect policy, never this permanent draft removal. */
	async deleteDraft(request: CategoryWriteRequest, categoryId: string) {
		const value = id.parse(categoryId)
		return this.run(request, { type: 'delete-draft', id: value }, value, ({ rows }) => {
			const row = rows.find(row => String(row._id) === value)
			if (!row) throw Error('CATEGORY_NOT_FOUND')
			if (row.attribute_contract_version !== 2)
				throw Error('CATALOG_CONTRACT_UPGRADE_REQUIRED')
			if (row.status !== 'draft') throw Error('CATEGORY_DELETE_REQUIRES_DRAFT')
			return { collection: 'categories', id: value, fields: {}, deletion: row }
		})
	}

	/**
	 * Characteristics of a draft or published v2 product category (Plan-0010 F03). Judged against
	 * the exact per-key usage read under the gate: allowed changes go through, the rest are refused
	 * with the counts of products, SKUs and landings they would break (`DefinitionChangeError`).
	 */
	async replaceDefinitions(
		request: CategoryWriteRequest,
		input: { id: string; definitions: DefinitionInput[] }
	) {
		const value = z.strictObject({ id, definitions: definitionsInputSchema }).parse(input)
		return this.run(request, { type: 'definitions', ...value }, value.id, async ({ rows }) => {
			const row = editable(rows, value.id)
			if (row.kind !== 'product') throw Error('CATEGORY_DEFINITIONS_REQUIRE_PRODUCT')
			const before = parseDefinitions(row.attribute_definitions)
			const next = resolveDefinitions(before, value.definitions, request.operationId)
			const data = await readCategoryData(this.db, value.id)
			const published = row.status === 'active'
			checkDefinitionChange(before, next, definitionUsage(before, data), { published })
			assertDataStaysValid(before, next, data, { published })
			return {
				collection: 'categories',
				id: value.id,
				fields: {
					attribute_definitions: {
						before: { exists: true, value: row.attribute_definitions },
						after: { exists: true, value: next }
					}
				}
			}
		})
	}

	/**
	 * Name and tile image of a draft or published v2 category. The slug (an address change is the
	 * redirect-backed B07 operation), kind and placement never change here. An absent image is
	 * left as it is; `null` removes it.
	 */
	async updateDetails(
		request: CategoryWriteRequest,
		input: { id: string; name: string; image?: string | null }
	) {
		const value = z
			.strictObject({
				id,
				name: z.string().trim().min(1).max(200),
				image: categoryImageSchema.optional()
			})
			.parse(input)
		return this.run(request, { type: 'details', ...value }, value.id, ({ rows }) => {
			const row = editable(rows, value.id)
			const named = rows.find(
				other => String(other._id) !== value.id && other.name === value.name
			)
			if (named) throw new CategoryIdentityConflict('name', named)
			const fields: CatalogPatch['fields'] = {}
			const after: Record<string, unknown> = { name: value.name }
			if (value.image !== undefined) after.image = value.image
			for (const [key, next] of Object.entries(after))
				if (!isDeepStrictEqual(row[key] ?? null, next))
					fields[key] = {
						before: Object.hasOwn(row, key)
							? { exists: true, value: row[key] }
							: { exists: false },
						after: { exists: true, value: next }
					}
			if (!Object.keys(fields).length) throw Error('CATEGORY_DETAILS_UNCHANGED')
			return { collection: 'categories', id: value.id, fields }
		})
	}

	async create(request: CategoryWriteRequest, input: CategoryCreation) {
		const value = creationSchema.parse(input)
		const definitions = parseDefinitions(value.attribute_definitions)
		if (value.kind === 'group' && definitions.length) throw Error('GROUP_ATTRIBUTES')
		return this.run(
			request,
			{ type: 'creation', ...value, attribute_definitions: definitions },
			value.id,
			async ({ rows, items }) => {
				if (rows.some(row => String(row._id) === value.id))
					throw Error('CATEGORY_IDENTITY_CONFLICT')
				const addressed = rows.find(row => row.slug === value.slug)
				if (addressed) throw new CategoryIdentityConflict('slug', addressed)
				const named = rows.find(row => row.name === value.name)
				if (named) throw new CategoryIdentityConflict('name', named)
				// The address must be free for a category, as for a slug change (B07): not a
				// storefront route, and not the old address of another entity — a live page there
				// would silently end that address's 301.
				if (reservedCategorySlug(value.slug)) throw Error('ROUTE_PATH_RESERVED')
				if (
					await this.db
						.collection('catalog_routes')
						.findOne(
							{ path: normalizeCatalogPath(`/${value.slug}`) },
							{ projection: { _id: 1 }, readPreference: 'primary' }
						)
				)
					throw Error('ROUTE_PATH_TAKEN')
				new CategoryTree([
					...items.map(item => ({
						id: item._id,
						parent_id: item.parent_id,
						kind: item.kind
					})),
					{ id: value.id, parent_id: value.parent_id, kind: value.kind }
				])
				const now = new Date()
				return {
					collection: 'categories',
					id: value.id,
					fields: {},
					creation: {
						_id: new mongo.ObjectId(value.id),
						name: value.name,
						slug: value.slug,
						parent_id:
							value.parent_id === null ? null : new mongo.ObjectId(value.parent_id),
						kind: value.kind,
						status: 'draft',
						order: value.order,
						attribute_contract_version: 2,
						attribute_definitions: definitions,
						required_attributes: [],
						image: null,
						google_product_category: null,
						createdAt: now,
						updatedAt: now
					}
				}
			}
		)
	}
}
