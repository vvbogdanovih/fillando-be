import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mongo } from 'mongoose'
import { z } from 'zod'
import { sanitizePlainText, sanitizeRichText } from 'src/common/utils/html.utils'
import { ColorFamily } from 'src/common/types/enums'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { runCatalogOperation } from 'src/database/mongoose/repositories/catalog-operation'
import { readCategoryConfiguration } from '../category/category-configuration'
import { parseAttributeFilters } from '../category/category-attribute-filters'
import { parseCatalogFilters, type CatalogFilters } from '../product/public-catalog-query'
import { normalizeCatalogPath } from '../catalog-routes/catalog-route-plan'

/**
 * Typed landings (Plan-0010 F07): a landing under a v2 product category pins a catalogue
 * `filters` object (`filters_v2`) and carries its own copy. Written through the catalogue gate and
 * journal (profile `landing`) — landing pins depend on the category's definitions, so they share
 * its revision (TD-0013 mutations §9) — instead of the legacy landing service, which the interlock
 * closes once the catalogue is migrated.
 */
export class TypedLandingError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'TypedLandingError'
	}
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/)
export const typedLandingBodySchema = z.strictObject({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(200),
	h1: z.string().trim().min(1).max(300),
	title: z.string().trim().min(1).max(300),
	meta_description: z.string().trim().min(1).max(1000),
	intro_html: z.string().max(100000).default(''),
	bottom_html: z.string().max(200000).default(''),
	faq: z
		.array(
			z.strictObject({
				q: z.string().trim().min(1).max(1000),
				a: z.string().trim().min(1).max(5000)
			})
		)
		.max(50)
		.default([]),
	filters_v2: z.unknown(),
	image: z.string().url().max(2000).nullable().default(null),
	order: z.number().int().nonnegative().max(100000).default(0),
	status: z.enum(['draft', 'active']).default('draft')
})
export const typedLandingCreateSchema = typedLandingBodySchema.extend({ category_id: objectId })
export type TypedLandingBody = z.infer<typeof typedLandingBodySchema>

/** Order-insensitive canonical form: two landings with the same pins are the same page. */
export function canonicalPins(filters: CatalogFilters) {
	return {
		attributes: [...(filters.attributes as { key: string; values?: unknown[] }[])]
			.map(filter =>
				filter.values
					? { ...filter, values: [...filter.values].map(String).sort() }
					: filter
			)
			.sort((a, b) => a.key.localeCompare(b.key)),
		brand_ids: [...filters.brand_ids].map(id => id.toLowerCase()).sort(),
		color_families: [...new Set(filters.color_families)].sort(),
		price: filters.price ?? null
	}
}

const requestSchema = z.strictObject({
	operationId: z.string().uuid(),
	ownerId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative().safe()
})
type Request = z.infer<typeof requestSchema>
/** Active SKUs a candidate's pins match in its category (the storefront count). */
export type LandingCounter = (categoryId: string, filters: CatalogFilters) => Promise<number>

export class TypedLandingWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(
		private readonly db: mongo.Db,
		private readonly count: LandingCounter
	) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'landing')
	}

	private async category(id: mongo.ObjectId) {
		const category = await this.db
			.collection('categories')
			.findOne({ _id: id }, { readPreference: 'primary' })
		if (!category) throw new TypedLandingError('CATEGORY_NOT_FOUND')
		const config = readCategoryConfiguration({
			...category,
			parent_id: category.parent_id == null ? null : String(category.parent_id)
		})
		if (
			config.attribute_contract_version !== 2 ||
			config.kind !== 'product' ||
			(category.status !== 'draft' && category.status !== 'active')
		)
			throw new TypedLandingError('LANDING_CATEGORY_INVALID')
		return { category, definitions: config.attribute_definitions! }
	}

	/** The pins, checked against the category: filterable keys, valid values, real colour axis. */
	private async pins(
		definitions: ReturnType<typeof readCategoryConfiguration>['attribute_definitions'],
		input: unknown
	) {
		let filters: CatalogFilters
		try {
			filters = parseCatalogFilters(input)
			parseAttributeFilters(definitions!, { attributes: filters.attributes })
		} catch {
			throw new TypedLandingError('LANDING_FILTERS_INVALID')
		}
		// `on_sale` too: the storefront landing does not send it, so the page would list more than
		// its pins promise (audit, 2026-11-07) — refused until it is supported end to end.
		if (
			filters.category_ids.length ||
			filters.product_ids.length ||
			filters.in_stock !== undefined ||
			filters.on_sale !== undefined
		)
			throw new TypedLandingError('LANDING_FILTERS_INVALID')
		if (
			filters.color_families.length &&
			(!definitions!.some(definition => definition.semantic === 'color') ||
				filters.color_families.some(
					family => !(Object.values(ColorFamily) as string[]).includes(family)
				))
		)
			throw new TypedLandingError('LANDING_FILTERS_INVALID')
		if (filters.brand_ids.length) {
			const found = await this.db.collection('brands').countDocuments({
				_id: { $in: filters.brand_ids.map(id => new mongo.ObjectId(id)) },
				status: 'active'
			})
			if (found !== new Set(filters.brand_ids.map(id => id.toLowerCase())).size)
				throw new TypedLandingError('LANDING_FILTERS_INVALID')
		}
		// A landing is a narrowing: without a pin it duplicates the category page.
		if (
			!filters.attributes.length &&
			!filters.color_families.length &&
			!filters.brand_ids.length
		)
			throw new TypedLandingError('LANDING_PINS_REQUIRED')
		return filters
	}

	private async document(
		categoryId: mongo.ObjectId,
		body: TypedLandingBody,
		exceptId?: mongo.ObjectId,
		currentSlug?: string
	) {
		const { category, definitions } = await this.category(categoryId)
		const filters = await this.pins(definitions, body.filters_v2)
		const siblings = await this.db
			.collection('landings')
			.find(
				{ category_id: categoryId, ...(exceptId ? { _id: { $ne: exceptId } } : {}) },
				{ readPreference: 'primary' }
			)
			.toArray()
		if (siblings.some(row => row.slug === body.slug))
			throw new TypedLandingError('LANDING_SLUG_TAKEN')
		// A new address must not be the old one of another entity: that stays its 301 (B07), and a
		// live landing there would end it. An unchanged address is not re-judged.
		const alias =
			body.slug === currentSlug
				? null
				: await this.db.collection('catalog_routes').findOne(
						{
							path: normalizeCatalogPath(`/${category.slug as string}/${body.slug}`)
						},
						{
							projection: { entity_type: 1, entity_id: 1 },
							readPreference: 'primary'
						}
					)
		if (
			alias &&
			!(
				exceptId &&
				alias.entity_type === 'landing' &&
				(alias.entity_id as mongo.ObjectId).equals(exceptId)
			)
		)
			throw new TypedLandingError('LANDING_SLUG_TAKEN')
		const canonical = canonicalPins(filters)
		if (
			siblings.some(row => {
				if (row.contract_version !== 2 || !row.filters_v2) return false
				try {
					return isDeepStrictEqual(
						canonicalPins(parseCatalogFilters(row.filters_v2)),
						canonical
					)
				} catch {
					return false
				}
			})
		)
			throw new TypedLandingError('LANDING_FILTERS_DUPLICATE')
		if (body.status === 'active' && (await this.count(String(categoryId), filters)) === 0)
			throw new TypedLandingError('LANDING_HAS_NO_PRODUCTS')
		return {
			slug: body.slug,
			h1: sanitizePlainText(body.h1),
			title: sanitizePlainText(body.title),
			meta_description: sanitizePlainText(body.meta_description),
			intro_html: sanitizeRichText(body.intro_html),
			bottom_html: sanitizeRichText(body.bottom_html),
			faq: body.faq.map(item => ({
				q: sanitizePlainText(item.q),
				a: sanitizePlainText(item.a)
			})),
			// Plain JSON: optional bounds left out are absent, never stored as undefined.
			filters_v2: JSON.parse(JSON.stringify(filters)) as Record<string, unknown>,
			contract_version: 2,
			image: body.image,
			order: body.order,
			status: body.status
		}
	}

	private async run(
		request: Request,
		command: object,
		build: () => Promise<CatalogPatch>,
		landingId: string
	) {
		request = requestSchema.parse(request)
		const { db, gate, journal } = this
		return runCatalogOperation(
			{ db, gate, journal },
			{
				request,
				hashed: {
					type: 'typed-landing',
					expected_revision: request.expectedRevision,
					command
				},
				receipt: { landing_id: landingId },
				build: async () => [await build()],
				verification: 'LANDING_VERIFICATION_FAILED'
			}
		)
	}

	async create(request: Request, input: unknown) {
		const { category_id, ...body } = typedLandingCreateSchema.parse(input)
		const id = createHash('sha256')
			.update(`landing:${request.operationId}`)
			.digest('hex')
			.slice(0, 24)
		return this.run(
			request,
			{ op: 'create', category_id, body },
			async () => {
				const categoryId = new mongo.ObjectId(category_id)
				const now = new Date()
				const document = {
					_id: new mongo.ObjectId(id),
					category_id: categoryId,
					...(await this.document(categoryId, body)),
					// Legacy shape kept for older readers: no legacy pins, no price bounds.
					filters: {},
					price_min: null,
					price_max: null,
					createdAt: now,
					updatedAt: now
				}
				return { collection: 'landings', id, fields: {}, creation: document }
			},
			id
		)
	}

	async update(request: Request, landingId: string, input: unknown) {
		objectId.parse(landingId)
		const body = typedLandingBodySchema.parse(input)
		return this.run(
			request,
			{ op: 'update', id: landingId, body },
			async () => {
				const current = await this.db
					.collection('landings')
					.findOne({ _id: new mongo.ObjectId(landingId) }, { readPreference: 'primary' })
				if (!current) throw new TypedLandingError('LANDING_NOT_FOUND')
				// A published landing's address is indexed: changing it is a redirect-backed
				// operation (B07), never an ordinary save.
				if (current.status === 'active' && current.slug !== body.slug)
					throw new TypedLandingError('LANDING_SLUG_LOCKED')
				const next: Record<string, unknown> = await this.document(
					current.category_id as mongo.ObjectId,
					body,
					current._id,
					current.slug as string
				)
				const fields: CatalogPatch['fields'] = {}
				for (const [key, value] of Object.entries(next))
					if (!isDeepStrictEqual(current[key], value))
						fields[key] = {
							before: Object.hasOwn(current, key)
								? { exists: true, value: current[key] as unknown }
								: { exists: false },
							after: { exists: true, value }
						}
				if (!Object.keys(fields).length) throw new TypedLandingError('LANDING_UNCHANGED')
				fields.updatedAt = {
					before: Object.hasOwn(current, 'updatedAt')
						? { exists: true, value: current.updatedAt as unknown }
						: { exists: false },
					after: { exists: true, value: new Date() }
				}
				return { collection: 'landings', id: landingId, fields }
			},
			landingId
		)
	}

	/** Drafts only: a published landing is an indexed address — unpublish first (and B07 decides its URL). */
	async remove(request: Request, landingId: string) {
		objectId.parse(landingId)
		return this.run(
			request,
			{ op: 'delete', id: landingId },
			async () => {
				const current = await this.db
					.collection('landings')
					.findOne({ _id: new mongo.ObjectId(landingId) }, { readPreference: 'primary' })
				if (!current) throw new TypedLandingError('LANDING_NOT_FOUND')
				if (current.status !== 'draft' || current.contract_version !== 2)
					throw new TypedLandingError('LANDING_DELETE_REQUIRES_DRAFT')
				return { collection: 'landings', id: landingId, fields: {}, deletion: current }
			},
			landingId
		)
	}
}
