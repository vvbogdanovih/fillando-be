import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mongo } from 'mongoose'
import { z } from 'zod'
import { ColorFamily } from 'src/common/types/enums'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	CatalogPatch,
	PLAN_MAX_TARGETS
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import {
	AttributeContractError,
	type AttributeDefinition,
	type AttributeEntry,
	type AttributeValue
} from './attribute-definitions'
import { parseAttributeFilters } from './category-attribute-filters'
import { readCategoryConfiguration } from './category-configuration'
import { normalizeCatalogPath } from '../catalog-routes/catalog-route-plan'
import { canonicalPins } from '../landing/typed-landing-writer'
import { parseCatalogFilters } from '../product/public-catalog-query'
import { TypedProductError, validateTypedProduct } from '../product/typed-product'
import { loadAxisColors } from '../product/typed-product-colors'
import {
	convertValue,
	matchDefinition,
	planTransfer,
	type TransferDrop
} from '../product/typed-product-transfer'

/**
 * Product category → group with an explicit distribution (TD-0013 mutations §5, Plan-0010 B02).
 * The admin assigns every product and every landing of the category to another v2 product
 * category; the server checks the whole distribution read-only (`plan`), stores it, and executes it
 * as one journal plan (profile `conversion`) under the catalogue gate: the category becomes a group
 * (its definitions, card and feed settings stay in the journal's before-images), each product and
 * all its SKUs move with their values carried over by key or label (nothing may be lost), each
 * landing moves with its pins in the target's keys and its old public address kept as an alias, and
 * — on request — the target categories move under the new group. URLs of the category and of every
 * product, SKU codes, IDs, prices and stock never change. Nothing is moved implicitly: without a
 * complete assignment the operation is refused.
 */
export class CategoryConversionError extends Error {
	constructor(
		readonly code: string,
		readonly details: Record<string, unknown> = {}
	) {
		super(code)
		this.name = 'CategoryConversionError'
	}
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/)
export const conversionPlanInputSchema = z.strictObject({
	target_kind: z.literal('group'),
	assignments: z
		.array(z.strictObject({ product_id: objectId, target_category_id: objectId }))
		.max(500),
	landing_assignments: z
		.array(z.strictObject({ landing_id: objectId, target_category_id: objectId }))
		.max(200)
		.default([]),
	/** Also move every target category under the converted group, in the same plan. */
	adopt_targets: z.boolean().default(false)
})
export type ConversionPlanInput = z.infer<typeof conversionPlanInputSchema>

export interface ConversionProblem {
	code: string
	product_id?: string
	landing_id?: string
	target_category_id?: string
	dropped?: TransferDrop[]
	missing_required?: string[]
	detail?: string
	/** CONVERSION_PLAN_TOO_LARGE: changes one operation may hold (`PLAN_MAX_TARGETS`). */
	limit?: number
}
export interface ConversionReport {
	category_id: string
	revision: number
	executable: boolean
	counts: {
		products: number
		variants: number
		landings: number
		targets: number
		variants_to_draft: number
		routes: number
		patches: number
	}
	products: {
		product_id: string
		name: string
		target_category_id: string
		mapped: number
		variants: number
	}[]
	landings: {
		landing_id: string
		slug: string
		status: string
		target_category_id: string
		from_path: string
		to_path: string
	}[]
	problems: ConversionProblem[]
	warnings: { code: string; target_category_id?: string; landing_id?: string; count?: number }[]
}

const image = (row: mongo.Document, key: string) =>
	Object.hasOwn(row, key)
		? { exists: true as const, value: row[key] as unknown }
		: { exists: false as const }
function change(row: mongo.Document, fields: Record<string, unknown>): CatalogPatch['fields'] {
	return Object.fromEntries(
		Object.entries(fields)
			.filter(([key, value]) =>
				value === undefined ? Object.hasOwn(row, key) : !isDeepStrictEqual(row[key], value)
			)
			.map(([key, value]) => [
				key,
				{
					before: image(row, key),
					after:
						value === undefined
							? { exists: false as const }
							: { exists: true as const, value }
				}
			])
	)
}

/**
 * A landing's pins in the target's terms (same matching as a product transfer); null when a pin
 * cannot be expressed there without guessing.
 */
export function remapPins(
	source: AttributeDefinition[],
	target: AttributeDefinition[],
	stored: unknown
): Record<string, unknown> | null {
	const filters = parseCatalogFilters(stored)
	const bySource = new Map(source.map(definition => [definition.key, definition]))
	const attributes: unknown[] = []
	for (const raw of filters.attributes as {
		key: string
		values?: AttributeValue[]
		min?: number
		max?: number
	}[]) {
		const definition = bySource.get(raw.key)
		const into = definition && matchDefinition(target, definition, false)
		if (!definition || !into) return null
		if (raw.values) {
			const values = raw.values.map(value => convertValue(definition, into, value))
			if (values.some(value => value === null)) return null
			attributes.push({ key: into.key, values })
		} else {
			if (definition.unit !== into.unit || into.value_type !== 'number') return null
			attributes.push({
				key: into.key,
				...(raw.min !== undefined ? { min: raw.min } : {}),
				...(raw.max !== undefined ? { max: raw.max } : {})
			})
		}
	}
	if (
		filters.color_families.length &&
		!target.some(definition => definition.semantic === 'color')
	)
		return null
	const plain = (stored ?? {}) as Record<string, unknown>
	return { ...plain, attributes }
}

interface Built {
	report: ConversionReport
	patches: CatalogPatch[]
	fingerprint: string
}

/**
 * Everything the conversion would write, read from the primary. Called read-only for the admin's
 * plan and again under the gate before execution; the fingerprint tells whether anything the plan
 * depends on changed in between.
 */
export async function buildConversion(
	db: mongo.Db,
	categoryId: string,
	input: ConversionPlanInput,
	revision: number,
	operationId: string
): Promise<Built> {
	const read = { readPreference: 'primary' as const }
	const categories = await db.collection('categories').find({}, read).toArray()
	const source = categories.find(row => String(row._id) === categoryId)
	if (!source) throw new CategoryConversionError('CATEGORY_NOT_FOUND')
	const config = readCategoryConfiguration({
		...source,
		parent_id: source.parent_id == null ? null : String(source.parent_id)
	})
	if (config.attribute_contract_version !== 2)
		throw new CategoryConversionError('CATALOG_CONTRACT_UPGRADE_REQUIRED')
	if (source.status !== 'draft' && source.status !== 'active')
		throw new CategoryConversionError('CATEGORY_ARCHIVED')
	if (config.kind !== 'product') throw new CategoryConversionError('CATEGORY_KIND_UNCHANGED')
	const sourceDefinitions = config.attribute_definitions!
	const sourceId = source._id
	const ids = [sourceId, categoryId]
	const [products, variants, landings] = await Promise.all([
		db
			.collection('products')
			.find({ category_id: { $in: ids } }, read)
			.sort({ _id: 1 })
			.toArray(),
		db
			.collection('product_variants')
			.find({ category_id: { $in: ids } }, read)
			.sort({ _id: 1 })
			.toArray(),
		db
			.collection('landings')
			.find({ category_id: { $in: ids } }, read)
			.sort({ _id: 1 })
			.toArray()
	])

	// Every product and landing exactly once — nothing is moved or left behind implicitly.
	const assignmentProblem = (
		kind: 'products' | 'landings',
		existing: string[],
		given: string[]
	) => {
		const missing = existing.filter(id => !given.includes(id))
		const unknown = given.filter(id => !existing.includes(id))
		const duplicate = given.filter((id, index) => given.indexOf(id) !== index)
		if (missing.length || unknown.length || duplicate.length)
			throw new CategoryConversionError('CONVERSION_ASSIGNMENTS_INVALID', {
				kind,
				missing,
				unknown,
				duplicate: [...new Set(duplicate)]
			})
	}
	assignmentProblem(
		'products',
		products.map(row => String(row._id)),
		input.assignments.map(row => row.product_id)
	)
	assignmentProblem(
		'landings',
		landings.map(row => String(row._id)),
		input.landing_assignments.map(row => row.landing_id)
	)

	const targetIds = [
		...new Set([
			...input.assignments.map(row => row.target_category_id),
			...input.landing_assignments.map(row => row.target_category_id)
		])
	]
	const targets = new Map<string, { row: mongo.Document; definitions: AttributeDefinition[] }>()
	for (const targetId of targetIds) {
		const row = categories.find(category => String(category._id) === targetId)
		const parsed =
			row &&
			readCategoryConfiguration({
				...row,
				parent_id: row.parent_id == null ? null : String(row.parent_id)
			})
		if (
			!row ||
			!parsed ||
			targetId === categoryId ||
			parsed.attribute_contract_version !== 2 ||
			parsed.kind !== 'product' ||
			(row.status !== 'draft' && row.status !== 'active')
		)
			throw new CategoryConversionError('CONVERSION_TARGET_INVALID', {
				target_category_id: targetId
			})
		targets.set(targetId, { row, definitions: parsed.attribute_definitions! })
	}

	const problems: ConversionProblem[] = []
	const warnings: ConversionReport['warnings'] = []
	const patches: CatalogPatch[] = []
	const reportProducts: ConversionReport['products'] = []
	const now = new Date()
	const variantsBy = new Map<string, mongo.Document[]>()
	for (const variant of variants) {
		const key = String(variant.product_id)
		variantsBy.set(key, [...(variantsBy.get(key) ?? []), variant])
	}
	// Active SKUs each target holds after the plan (its own plus those moving in).
	const activeAfter = new Map<string, number>()
	for (const targetId of targetIds)
		activeAfter.set(
			targetId,
			await db.collection('product_variants').countDocuments(
				{
					category_id: { $in: [new mongo.ObjectId(targetId), targetId] },
					status: 'active'
				},
				read
			)
		)
	// A SKU listed under this category but owned by a product elsewhere (or the reverse) would be
	// left behind after the move and fail verification with the gate closed: refuse it up front.
	const productIds = new Set(products.map(row => String(row._id)))
	const owned = await db
		.collection('product_variants')
		.countDocuments({ product_id: { $in: products.map(row => row._id) } }, read)
	if (variants.some(row => !productIds.has(String(row.product_id))) || owned !== variants.length)
		problems.push({ code: 'CONVERSION_DATA_INCONSISTENT' })
	let toDraft = 0
	const colors = await loadAxisColors(
		db,
		variants.map(row => row.variant_value as unknown)
	)
	for (const assignment of input.assignments) {
		const product = products.find(row => String(row._id) === assignment.product_id)!
		const own = variantsBy.get(assignment.product_id) ?? []
		const target = targets.get(assignment.target_category_id)!
		const published = target.row.status === 'active'
		const axisKey = (product.variant_axis as { key?: string } | null | undefined)?.key ?? null
		const plan = planTransfer(
			{
				definitions: sourceDefinitions,
				attributes_v2: (product.attributes_v2 ?? []) as AttributeEntry[],
				axisKey,
				variants: own.map(row => ({
					id: String(row._id),
					variant_value: (row.variant_value ?? null) as AttributeValue | null
				}))
			},
			target.definitions
		)
		reportProducts.push({
			product_id: assignment.product_id,
			name: String(product.name),
			target_category_id: assignment.target_category_id,
			mapped: plan.mapped.length,
			variants: own.length
		})
		const base = {
			product_id: assignment.product_id,
			target_category_id: assignment.target_category_id
		}
		if (plan.dropped.length)
			problems.push({
				code: 'CONVERSION_PRODUCT_LOSES_VALUES',
				...base,
				dropped: plan.dropped
			})
		if (plan.axis_problem)
			problems.push({ code: 'CONVERSION_PRODUCT_AXIS', ...base, detail: plan.axis_problem })
		if (published && plan.missing_required.length)
			problems.push({
				code: 'CONVERSION_PRODUCT_MISSING_REQUIRED',
				...base,
				missing_required: plan.missing_required
			})
		if (plan.dropped.length || plan.axis_problem || (published && plan.missing_required.length))
			continue
		let next: ReturnType<typeof validateTypedProduct>
		try {
			next = validateTypedProduct(
				target.definitions,
				{
					name: product.name as unknown,
					attributes_v2: plan.attributes_v2,
					variant_axis: plan.variant_axis,
					variants: plan.variants
				},
				{ active: published, labelFor: value => colors.get(String(value))?.label ?? null }
			)
		} catch (error) {
			if (!(error instanceof TypedProductError || error instanceof AttributeContractError))
				throw error
			problems.push({ code: 'CONVERSION_PRODUCT_INVALID', ...base, detail: error.code })
			continue
		}
		const targetId = target.row._id as mongo.ObjectId
		patches.push({
			collection: 'products',
			id: assignment.product_id,
			fields: change(product, {
				category_id: targetId,
				attributes_v2: next.attributes_v2,
				variant_axis: next.variant_axis
			})
		})
		for (const row of next.variants) {
			const variant = own.find(item => String(item._id) === row.id)!
			// A draft category sells nothing: its SKUs become drafts, as in a product transfer.
			const draft = variant.status === 'active' && !published
			if (draft) toDraft++
			if (variant.status === 'active' && published)
				activeAfter.set(
					assignment.target_category_id,
					activeAfter.get(assignment.target_category_id)! + 1
				)
			patches.push({
				collection: 'product_variants',
				id: row.id,
				fields: change(variant, {
					category_id: targetId,
					name: row.name,
					variant_value: row.variant_value,
					...(draft ? { status: 'draft' } : {})
				})
			})
		}
	}
	if (toDraft) warnings.push({ code: 'CONVERSION_ACTIVE_SKUS_TO_DRAFT', count: toDraft })

	// Landings: pins in the target's keys, unique slug and pins there, the old address kept.
	const routes = db.collection('catalog_routes')
	const reportLandings: ConversionReport['landings'] = []
	const settings = await db.collection('storefront_settings').findOne({}, read)
	let routeCount = 0
	for (const assignment of input.landing_assignments) {
		const landing = landings.find(row => String(row._id) === assignment.landing_id)!
		const target = targets.get(assignment.target_category_id)!
		const from = `/${String(source.slug)}/${String(landing.slug)}`
		const to = `/${String(target.row.slug)}/${String(landing.slug)}`
		reportLandings.push({
			landing_id: assignment.landing_id,
			slug: String(landing.slug),
			status: String(landing.status),
			target_category_id: assignment.target_category_id,
			from_path: from,
			to_path: to
		})
		const base = {
			landing_id: assignment.landing_id,
			target_category_id: assignment.target_category_id
		}
		if (landing.contract_version !== 2 || !landing.filters_v2) {
			problems.push({ code: 'CONVERSION_LANDING_NOT_TYPED', ...base })
			continue
		}
		let pins: Record<string, unknown> | null
		try {
			pins = remapPins(sourceDefinitions, target.definitions, landing.filters_v2)
			if (pins) {
				const parsed = parseCatalogFilters(pins)
				parseAttributeFilters(target.definitions, { attributes: parsed.attributes })
				if (
					parsed.color_families.some(
						family => !(Object.values(ColorFamily) as string[]).includes(family)
					)
				)
					pins = null
			}
		} catch {
			pins = null
		}
		if (!pins) {
			problems.push({ code: 'CONVERSION_LANDING_PINS', ...base })
			continue
		}
		const siblings = [
			...(await db
				.collection('landings')
				.find({ category_id: target.row._id }, read)
				.toArray()),
			...input.landing_assignments
				.filter(
					row =>
						row.target_category_id === assignment.target_category_id &&
						row.landing_id !== assignment.landing_id
				)
				.map(row => landings.find(item => String(item._id) === row.landing_id)!)
		]
		if (siblings.some(row => row.slug === landing.slug)) {
			problems.push({ code: 'CONVERSION_LANDING_SLUG_TAKEN', ...base })
			continue
		}
		const canonical = canonicalPins(parseCatalogFilters(pins))
		if (
			siblings.some(row => {
				const other =
					String(row.category_id) === categoryId
						? remapPins(sourceDefinitions, target.definitions, row.filters_v2)
						: (row.filters_v2 as unknown)
				try {
					return (
						row.contract_version === 2 &&
						other !== null &&
						isDeepStrictEqual(canonicalPins(parseCatalogFilters(other)), canonical)
					)
				} catch {
					return false
				}
			})
		) {
			problems.push({ code: 'CONVERSION_LANDING_PINS_DUPLICATE', ...base })
			continue
		}
		patches.push({
			collection: 'landings',
			id: assignment.landing_id,
			fields: change(landing, {
				category_id: target.row._id,
				filters_v2: isDeepStrictEqual(pins, landing.filters_v2) ? landing.filters_v2 : pins,
				updatedAt: now
			})
		})
		if (landing.status === 'active') {
			if (target.row.status !== 'active')
				warnings.push({ code: 'CONVERSION_LANDING_HIDDEN', ...base })
			// The published address keeps working: an alias of the landing, never a chain.
			const [atFrom, atTo] = await Promise.all([
				routes.findOne({ path: normalizeCatalogPath(from) }, read),
				routes.findOne({ path: normalizeCatalogPath(to) }, read)
			])
			const own = (alias: mongo.Document | null) =>
				alias?.entity_type === 'landing' &&
				String(alias.entity_id) === assignment.landing_id
			if ((atFrom && !own(atFrom)) || (atTo && !own(atTo))) {
				problems.push({ code: 'ROUTE_PATH_TAKEN', ...base })
				continue
			}
			if (atTo)
				patches.push({
					collection: 'catalog_routes',
					id: String(atTo._id),
					fields: {},
					deletion: atTo
				})
			if (!atFrom) {
				const aliasId = createHash('sha256')
					.update(`route:${operationId}:${from}`)
					.digest('hex')
					.slice(0, 24)
				patches.push({
					collection: 'catalog_routes',
					id: aliasId,
					fields: {},
					creation: {
						_id: new mongo.ObjectId(aliasId),
						path: normalizeCatalogPath(from),
						kind: 'alias',
						entity_type: 'landing',
						entity_id: landing._id,
						created_at: now,
						operation_id: operationId
					}
				})
				routeCount++
			}
		}
	}
	for (const assignment of input.landing_assignments) {
		const landing = landings.find(row => String(row._id) === assignment.landing_id)!
		if (landing.status === 'active' && !activeAfter.get(assignment.target_category_id))
			warnings.push({
				code: 'CONVERSION_LANDING_TARGET_EMPTY',
				landing_id: assignment.landing_id,
				target_category_id: assignment.target_category_id
			})
	}
	// Collections that show a moved landing follow it to its new category.
	const collections = (settings?.collections ?? []) as {
		category_id: unknown
		landing_id: unknown
	}[]
	const landingOf = (row: { landing_id: unknown }) =>
		row.landing_id instanceof mongo.ObjectId ? row.landing_id.toHexString() : null
	if (
		settings &&
		collections.some(row =>
			input.landing_assignments.some(a => landingOf(row) === a.landing_id)
		)
	) {
		patches.push({
			collection: 'storefront_settings',
			id: String(settings._id),
			fields: change(settings, {
				collections: collections.map(row => {
					const moved = input.landing_assignments.find(
						a => landingOf(row) === a.landing_id
					)
					return moved
						? { ...row, category_id: new mongo.ObjectId(moved.target_category_id) }
						: row
				}),
				updatedAt: now
			})
		})
	}

	// The category itself: a group owns no definitions, card or Google taxonomy (kept as
	// before-images).
	const dropped = ['presentation', 'google_product_category'].filter(key => source[key] != null)
	if (dropped.length)
		warnings.push({ code: 'CONVERSION_SETTINGS_NOT_CARRIED', count: dropped.length })
	patches.unshift({
		collection: 'categories',
		id: categoryId,
		fields: change(source, {
			kind: 'group',
			attribute_definitions: [],
			presentation: undefined,
			google_product_category: undefined,
			updatedAt: now
		})
	})
	if (input.adopt_targets) {
		const adopted = [...new Set(input.assignments.map(row => row.target_category_id))]
		adopted.forEach((targetId, index) => {
			const target = targets.get(targetId)!.row
			if (target.status === 'active' && source.status !== 'active') {
				problems.push({ code: 'CATEGORY_PARENT_NOT_PUBLIC', target_category_id: targetId })
				return
			}
			patches.push({
				collection: 'categories',
				id: targetId,
				fields: change(target, { parent_id: sourceId, order: index, updatedAt: now })
			})
		})
	}
	if (patches.length > PLAN_MAX_TARGETS)
		problems.push({
			code: 'CONVERSION_PLAN_TOO_LARGE',
			detail: String(patches.length),
			limit: PLAN_MAX_TARGETS
		})

	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify(
				patches.map(patch => ({
					c: patch.collection,
					// A new alias's id derives from the operation id, which the read-only check
					// does not have yet; its path identifies it.
					id: patch.creation ? null : patch.id,
					after: Object.fromEntries(
						Object.entries(patch.fields)
							.filter(([key]) => key !== 'updatedAt')
							.map(([key, value]) => [key, [value.before, value.after]])
					),
					created: patch.creation ? String(patch.creation.path) : null,
					deleted: patch.deletion ? String(patch.deletion._id) : null
				}))
			)
		)
		.digest('hex')
	return {
		report: {
			category_id: categoryId,
			revision,
			executable: problems.length === 0,
			counts: {
				products: products.length,
				variants: variants.length,
				landings: landings.length,
				targets: targetIds.length,
				variants_to_draft: toDraft,
				routes: routeCount,
				patches: patches.length
			},
			products: reportProducts,
			landings: reportLandings,
			problems,
			warnings
		},
		patches,
		fingerprint
	}
}

interface StoredPlan {
	_id: string
	category_id: string
	source_revision: number
	input: ConversionPlanInput
	fingerprint: string
	created_at: Date
}
const requestSchema = z.strictObject({
	operationId: z.string().uuid(),
	ownerId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative().safe()
})

/** Read-only plan (stored for one revision) and its single execution under the gate. */
export class CategoryConversionWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	private readonly plans: mongo.Collection<StoredPlan>
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'conversion')
		this.plans = db.collection<StoredPlan>('catalog_conversion_plans', {
			writeConcern: { w: 1, j: true }
		})
	}

	private async enabled() {
		return this.db
			.collection<{ _id: string }>('catalog_control')
			.findOne(
				{ _id: 'catalog', admin_draft_writes_enabled: true },
				{ readPreference: 'primary' }
			)
	}

	/** Checks the distribution on one verified snapshot; an executable plan is stored for it. */
	async plan(categoryId: string, raw: unknown) {
		objectId.parse(categoryId)
		const input = conversionPlanInputSchema.parse(raw)
		if (!(await this.enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
		const stamp = await this.gate.readStamp()
		const built = await buildConversion(
			this.db,
			categoryId,
			input,
			stamp.revision,
			'conversion-plan'
		)
		await this.gate.assertReadUnchanged(stamp)
		if (!built.report.executable) return { plan_id: null, ...built.report }
		const planId = randomUUID()
		await this.plans.insertOne({
			_id: planId,
			category_id: categoryId,
			source_revision: stamp.revision,
			input,
			fingerprint: built.fingerprint,
			created_at: new Date()
		})
		return { plan_id: planId, ...built.report }
	}

	async execute(request: z.infer<typeof requestSchema>, categoryId: string, planId: string) {
		request = requestSchema.parse(request)
		objectId.parse(categoryId)
		z.string().uuid().parse(planId)
		const hash = createHash('sha256')
			.update(
				mongo.BSON.serialize({
					type: 'category-conversion',
					id: categoryId,
					plan_id: planId,
					expected_revision: request.expectedRevision
				})
			)
			.digest('hex')
		if (!(await this.enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
		const receipt = (revision: number) => ({
			operation_id: request.operationId,
			revision,
			category_id: categoryId
		})
		const previous = await this.gate.operation(request.operationId)
		if (previous) {
			if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			if (previous.status === 'completed' && previous.revision !== undefined)
				return receipt(previous.revision)
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}
		const stored = await this.plans.findOne({ _id: planId }, { readPreference: 'primary' })
		if (!stored || stored.category_id !== categoryId)
			throw new CategoryConversionError('CONVERSION_PLAN_NOT_FOUND')
		// A plan is for the revision it was checked on; anything newer means a fresh check.
		if (stored.source_revision !== request.expectedRevision)
			throw new CategoryConversionError('CONVERSION_PLAN_STALE')
		await this.db.collection('catalog_routes').createIndex({ path: 1 }, { unique: true })
		const token = await this.gate.acquire(
			request.operationId,
			hash,
			request.ownerId,
			request.expectedRevision
		)
		let started = false
		try {
			if (!(await this.enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
			const built = await buildConversion(
				this.db,
				categoryId,
				stored.input,
				token.revision,
				request.operationId
			)
			if (!built.report.executable)
				throw new CategoryConversionError('CONVERSION_PLAN_BLOCKED', {
					problems: built.report.problems
				})
			if (built.fingerprint !== stored.fingerprint)
				throw new CategoryConversionError('CONVERSION_PLAN_CHANGED')
			await this.journal.prepare(token, built.patches)
			started = true
			await this.journal.execute(token, 'apply')
			const ids = [new mongo.ObjectId(categoryId), categoryId]
			const [left, category, inspection] = await Promise.all([
				Promise.all(
					['products', 'product_variants', 'landings'].map(collection =>
						this.db
							.collection(collection)
							.countDocuments(
								{ category_id: { $in: ids } },
								{ readPreference: 'primary' }
							)
					)
				),
				this.db
					.collection('categories')
					.findOne(
						{ _id: new mongo.ObjectId(categoryId) },
						{ readPreference: 'primary' }
					),
				this.journal.inspect(request.operationId)
			])
			if (
				left.some(count => count > 0) ||
				category?.kind !== 'group' ||
				inspection.counts.after + inspection.counts.both !== built.patches.length
			)
				throw Error('CATEGORY_CONVERSION_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			await this.plans.deleteOne({ _id: planId })
			return receipt(token.revision + 1)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}
}
