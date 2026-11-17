import { createHash } from 'node:crypto'
import { mongo } from 'mongoose'
import { z } from 'zod'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { runCatalogOperation } from 'src/database/mongoose/repositories/catalog-operation'
import {
	normalizeCatalogPath,
	reservedCategorySlug,
	type CatalogEntity
} from './catalog-route-plan'

/**
 * Redirect-backed address changes (Plan-0010 B07, TD-0013 «slug-change»). An ordinary rename never
 * changes a URL; this explicit operation does, and keeps every old address alive as an alias in
 * `catalog_routes` that points at the entity — not at a path — so the redirect always lands on the
 * entity's current address and never chains (A → B → C). Real storefront paths: a category at
 * `/{slug}`, its landing at `/{category}/{landing}`, a SKU at `/products/{slug}`. One journal plan
 * (profile `routes`) writes the slug and the aliases; an alias the entity owns is reclaimed when it
 * moves back to that address.
 */
export class CatalogRouteChangeError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'CatalogRouteChangeError'
	}
}

const slugSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	.max(200)
const requestSchema = z.strictObject({
	operationId: z.string().uuid(),
	ownerId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative().safe()
})
type Request = z.infer<typeof requestSchema>
interface Alias {
	_id: mongo.ObjectId
	path: string
	kind: 'alias'
	entity_type: CatalogEntity
	entity_id: mongo.ObjectId
}

export class CatalogRouteChangeWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	private readonly routes: mongo.Collection<Alias>
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'routes')
		this.routes = db.collection<Alias>('catalog_routes')
	}

	private slugPatch(
		collection: CatalogPatch['collection'],
		row: mongo.Document,
		slug: string
	): CatalogPatch {
		return {
			collection,
			id: String(row._id),
			fields: {
				slug: {
					before: { exists: true, value: row.slug },
					after: { exists: true, value: slug }
				},
				updatedAt: {
					before: Object.hasOwn(row, 'updatedAt')
						? { exists: true, value: row.updatedAt as unknown }
						: { exists: false },
					after: { exists: true, value: new Date() }
				}
			}
		}
	}

	/**
	 * The alias patches for one entity moving `from` → `to`: the old address becomes an alias (if
	 * it is not one already), an alias of this entity at the new address is reclaimed, and an
	 * address owned by anything else is a conflict.
	 */
	private async aliasPatches(
		entityType: CatalogEntity,
		entityId: mongo.ObjectId,
		from: string,
		to: string,
		operationId: string
	): Promise<CatalogPatch[]> {
		const patches: CatalogPatch[] = []
		const [target, source] = await Promise.all([
			this.routes.findOne({ path: normalizeCatalogPath(to) }, { readPreference: 'primary' }),
			this.routes.findOne({ path: normalizeCatalogPath(from) }, { readPreference: 'primary' })
		])
		const own = (alias: Alias | null) =>
			alias !== null && alias.entity_type === entityType && alias.entity_id.equals(entityId)
		if (target && !own(target)) throw new CatalogRouteChangeError('ROUTE_PATH_TAKEN')
		if (target)
			patches.push({
				collection: 'catalog_routes',
				id: String(target._id),
				fields: {},
				deletion: target
			})
		if (source && !own(source)) throw new CatalogRouteChangeError('ROUTE_PATH_TAKEN')
		if (!source) {
			const id = createHash('sha256')
				.update(`route:${operationId}:${from}`)
				.digest('hex')
				.slice(0, 24)
			patches.push({
				collection: 'catalog_routes',
				id,
				fields: {},
				creation: {
					_id: new mongo.ObjectId(id),
					path: normalizeCatalogPath(from),
					kind: 'alias',
					entity_type: entityType,
					entity_id: entityId,
					created_at: new Date(),
					operation_id: operationId
				}
			})
		}
		return patches
	}

	private async run(request: Request, command: object, build: () => Promise<CatalogPatch[]>) {
		request = requestSchema.parse(request)
		const { db, gate, journal } = this
		return runCatalogOperation(
			{ db, gate, journal },
			{
				request,
				hashed: {
					type: 'route-change',
					expected_revision: request.expectedRevision,
					command
				},
				receipt: {},
				beforeAcquire: () => this.routes.createIndex({ path: 1 }, { unique: true }),
				build,
				verification: 'ROUTE_CHANGE_VERIFICATION_FAILED'
			}
		)
	}

	async changeVariantSlug(request: Request, variantId: string, input: unknown) {
		const slug = slugSchema.parse(input)
		return this.run(request, { op: 'variant', id: variantId, slug }, async () => {
			const variant = await this.db
				.collection('product_variants')
				.findOne({ _id: new mongo.ObjectId(variantId) }, { readPreference: 'primary' })
			if (!variant) throw new CatalogRouteChangeError('ROUTE_ENTITY_NOT_FOUND')
			if (variant.slug === slug) throw new CatalogRouteChangeError('ROUTE_SLUG_UNCHANGED')
			const taken = await this.db
				.collection('product_variants')
				.findOne({ slug, _id: { $ne: variant._id } }, { projection: { _id: 1 } })
			if (taken) throw new CatalogRouteChangeError('ROUTE_PATH_TAKEN')
			return [
				this.slugPatch('product_variants', variant, slug),
				...(await this.aliasPatches(
					'variant',
					variant._id,
					`/products/${variant.slug as string}`,
					`/products/${slug}`,
					request.operationId
				))
			]
		})
	}

	async changeCategorySlug(request: Request, categoryId: string, input: unknown) {
		const slug = slugSchema.parse(input)
		return this.run(request, { op: 'category', id: categoryId, slug }, async () => {
			const category = await this.db
				.collection('categories')
				.findOne({ _id: new mongo.ObjectId(categoryId) }, { readPreference: 'primary' })
			if (!category) throw new CatalogRouteChangeError('ROUTE_ENTITY_NOT_FOUND')
			if (
				category.attribute_contract_version !== 2 ||
				!['draft', 'active'].includes(category.status as string)
			)
				throw new CatalogRouteChangeError('ROUTE_ENTITY_UNAVAILABLE')
			if (category.slug === slug) throw new CatalogRouteChangeError('ROUTE_SLUG_UNCHANGED')
			if (reservedCategorySlug(slug)) throw new CatalogRouteChangeError('ROUTE_PATH_RESERVED')
			const taken = await this.db
				.collection('categories')
				.findOne({ slug, _id: { $ne: category._id } }, { projection: { _id: 1 } })
			if (taken) throw new CatalogRouteChangeError('ROUTE_PATH_TAKEN')
			const patches: CatalogPatch[] = [
				this.slugPatch('categories', category, slug),
				...(await this.aliasPatches(
					'category',
					category._id,
					`/${category.slug as string}`,
					`/${slug}`,
					request.operationId
				))
			]
			// Every landing of the category keeps its old address too.
			const landings = await this.db
				.collection('landings')
				.find({ category_id: category._id }, { readPreference: 'primary' })
				.toArray()
			for (const landing of landings)
				patches.push(
					...(await this.aliasPatches(
						'landing',
						landing._id,
						`/${category.slug as string}/${landing.slug as string}`,
						`/${slug}/${landing.slug as string}`,
						request.operationId
					))
				)
			return patches
		})
	}

	async changeLandingSlug(request: Request, landingId: string, input: unknown) {
		const slug = slugSchema.parse(input)
		return this.run(request, { op: 'landing', id: landingId, slug }, async () => {
			const landing = await this.db
				.collection('landings')
				.findOne({ _id: new mongo.ObjectId(landingId) }, { readPreference: 'primary' })
			if (!landing || landing.contract_version !== 2)
				throw new CatalogRouteChangeError('ROUTE_ENTITY_NOT_FOUND')
			if (landing.slug === slug) throw new CatalogRouteChangeError('ROUTE_SLUG_UNCHANGED')
			const category = await this.db
				.collection('categories')
				.findOne(
					{ _id: landing.category_id as mongo.ObjectId },
					{ readPreference: 'primary' }
				)
			if (!category) throw new CatalogRouteChangeError('ROUTE_ENTITY_NOT_FOUND')
			const taken = await this.db
				.collection('landings')
				.findOne(
					{ category_id: category._id, slug, _id: { $ne: landing._id } },
					{ projection: { _id: 1 } }
				)
			if (taken) throw new CatalogRouteChangeError('ROUTE_PATH_TAKEN')
			return [
				this.slugPatch('landings', landing, slug),
				...(await this.aliasPatches(
					'landing',
					landing._id,
					`/${category.slug as string}/${landing.slug as string}`,
					`/${category.slug as string}/${slug}`,
					request.operationId
				))
			]
		})
	}
}
