import { isDeepStrictEqual } from 'node:util'
import { mongo } from 'mongoose'
import { CatalogWriteGate, CatalogWriteToken } from './catalog-write-gate'

type Image = { exists: false } | { exists: true; value: unknown }
export interface CatalogPatch {
	collection:
		| 'categories'
		| 'products'
		| 'product_variants'
		| 'landings'
		| 'storefront_settings'
		| 'catalog_routes'
		| 'colors'
	id: string
	fields: Record<string, { before: Image; after: Image }>
	/** Insert-only category, product or draft SKU image; absent before-image. */
	creation?: mongo.Document
	/** Removal of an unused v2 draft; full before-image, empty fields. */
	deletion?: mongo.Document
}
interface Plan {
	_id: string
	token: CatalogWriteToken
	patches: CatalogPatch[]
	phase: 'prepared' | 'applying' | 'applied' | 'rolling_back' | 'rolled_back'
	checkpoint: number
}
const allowed: Record<CatalogPatch['collection'], readonly string[]> = {
	categories: [
		'name',
		'parent_id',
		'kind',
		'attribute_contract_version',
		'attribute_definitions',
		// Retired 2026-11-05 (category presentation); kept so converting a category that still
		// stores it to a group can unset it (`category-conversion.ts`).
		'presentation',
		'order',
		// Tile image of a draft or published category (new admin «Деталі категорії»).
		'image'
	],
	products: ['name', 'category_id', 'attributes_v2', 'variant_axis'],
	product_variants: ['name', 'category_id', 'variant_value'],
	landings: ['category_id', 'filters_v2', 'contract_version'],
	// Only through the `settings` profile below.
	storefront_settings: [],
	// Old addresses (aliases): created/removed only through the `routes` profile.
	catalog_routes: [],
	// The colour dictionary: only through the `colors` profile.
	colors: []
}
/** Colour dictionary entry (new admin «Кольори»): its own fields; SKUs keep `color_family`/`name`. */
const COLOR_FIELDS = ['name_uk', 'name_en', 'slug', 'family', 'hex_stops', 'order', 'updatedAt']
/**
 * Storefront settings (Plan-0010 B09, TD-0015): the singleton document's editable fields. The old
 * `home_category_ids` stays listed only so that a save can remove it.
 */
const SETTINGS_FIELDS = [
	'strip',
	'banner',
	'side_promo',
	'band',
	'collections',
	'home_category_ids',
	'updatedAt'
]
/** Typed landing editor (Plan-0010 F07): the landing's own copy, pins and lifecycle. */
const LANDING_FIELDS = [
	'slug',
	'h1',
	'title',
	'meta_description',
	'intro_html',
	'bottom_html',
	'faq',
	'filters_v2',
	'contract_version',
	'order',
	'status',
	'image',
	'price_min',
	'price_max',
	'updatedAt'
]
export class CatalogJournalError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'CatalogJournalError'
	}
}

/** Bounded field updates and category lifecycle; never whole-product snapshot restoration. */
/** One journal plan at most: the targets it changes and its stored size (CLIs check them too). */
export const PLAN_MAX_TARGETS = 500
export const PLAN_MAX_BYTES = 8 * 1024 * 1024
/**
 * Targets checked at once. The checks around the writes are reads of independent documents, and
 * one after another they cost a round trip each while the catalogue is closed: 360 targets from a
 * laptop to a remote database were three passes of 16 s (measured 15.11.2026, 40 ms). The writes
 * themselves stay one target at a time, in plan order.
 */
const READ_BATCH = 20

export class CatalogMutationJournal {
	private readonly plans: mongo.Collection<Plan>
	constructor(
		private readonly db: mongo.Db,
		private readonly gate: CatalogWriteGate,
		private readonly profile:
			| 'catalog'
			| 'draft-product-details'
			| 'publication'
			| 'migration'
			| 'landing'
			// Managed SEO copy of a category (Plan-0010 B09/F05): the `seo` object only.
			| 'seo'
			// Feed export rules of a category (Plan-0010 B10).
			| 'export'
			// Redirect-backed address changes (Plan-0010 B07): slugs and their aliases.
			| 'routes'
			// The colour dictionary and what SKUs denormalize from it (family, display name).
			| 'colors'
			// Product category → group with an explicit distribution (Plan-0010 B02, TD §5): the
			// category, its products/SKUs/landings, aliases of moved landings, collections.
			| 'conversion'
			| 'settings' = 'catalog'
	) {
		this.plans = db.collection<Plan>('catalog_mutation_plans', {
			writeConcern: { w: 1, j: true }
		})
	}

	async prepare(token: CatalogWriteToken, patches: CatalogPatch[]): Promise<void> {
		await this.gate.assertWriting(token)
		if (!Array.isArray(patches) || patches.length === 0 || patches.length > PLAN_MAX_TARGETS)
			throw new CatalogJournalError('INVALID_PLAN')
		const targets = new Set<string>()
		for (const patch of patches) {
			if (
				!patch ||
				!Object.hasOwn(allowed, patch.collection) ||
				!/^[a-f0-9]{24}$/.test(patch.id) ||
				!patch.fields ||
				(!Object.keys(patch.fields).length && !patch.creation && !patch.deletion)
			)
				throw new CatalogJournalError('INVALID_PLAN')
			const landing = this.profile === 'landing' && patch.collection === 'landings'
			const settings =
				this.profile === 'settings' && patch.collection === 'storefront_settings'
			const route =
				(this.profile === 'routes' || this.profile === 'conversion') &&
				patch.collection === 'catalog_routes'
			const color = this.profile === 'colors' && patch.collection === 'colors'
			// Removal of a never-sold product or SKU by the new admin (the old admin's «Видалити»).
			const product =
				this.profile === 'draft-product-details' &&
				['products', 'product_variants'].includes(patch.collection)
			if (patch.creation !== undefined) {
				if (
					!(
						['categories', 'products', 'product_variants'].includes(patch.collection) ||
						landing ||
						settings ||
						route ||
						color
					) ||
					Object.keys(patch.fields).length ||
					!patch.creation ||
					!(patch.creation._id instanceof mongo.ObjectId) ||
					patch.creation._id.toHexString() !== patch.id
				)
					throw new CatalogJournalError('INVALID_CREATION')
				if (
					landing &&
					(!(patch.creation.category_id instanceof mongo.ObjectId) ||
						typeof patch.creation.slug !== 'string' ||
						patch.creation.contract_version !== 2 ||
						!patch.creation.filters_v2 ||
						typeof patch.creation.filters_v2 !== 'object' ||
						!['draft', 'active'].includes(patch.creation.status as string))
				)
					throw new CatalogJournalError('INVALID_CREATION')
				if (
					route &&
					(typeof patch.creation.path !== 'string' ||
						patch.creation.kind !== 'alias' ||
						!['category', 'landing', 'variant'].includes(
							patch.creation.entity_type as string
						) ||
						!(patch.creation.entity_id instanceof mongo.ObjectId))
				)
					throw new CatalogJournalError('INVALID_CREATION')
				if (
					color &&
					(typeof patch.creation.name_en !== 'string' ||
						typeof patch.creation.slug !== 'string' ||
						typeof patch.creation.family !== 'string' ||
						!Array.isArray(patch.creation.hex_stops))
				)
					throw new CatalogJournalError('INVALID_CREATION')
				if (
					!landing &&
					!settings &&
					!route &&
					!color &&
					patch.collection !== 'categories' &&
					(!(patch.creation.category_id instanceof mongo.ObjectId) ||
						typeof patch.creation.name !== 'string' ||
						!patch.creation.name ||
						(patch.collection === 'products' &&
							(!Array.isArray(patch.creation.attributes_v2) ||
								!Object.hasOwn(patch.creation, 'variant_axis'))) ||
						(patch.collection === 'product_variants' &&
							// A new SKU is a draft, or active when added to a published product as the
							// old admin's «Статус» allowed (owner decision 2026-10-27).
							(!['draft', 'active'].includes(patch.creation.status as string) ||
								!(patch.creation.product_id instanceof mongo.ObjectId) ||
								typeof patch.creation.sku !== 'string' ||
								typeof patch.creation.slug !== 'string')))
				)
					throw new CatalogJournalError('INVALID_CREATION')
			}

			if (patch.deletion !== undefined) {
				if (
					!(patch.collection === 'categories' || landing || route || color || product) ||
					patch.creation !== undefined ||
					Object.keys(patch.fields).length ||
					!patch.deletion ||
					!(patch.deletion._id instanceof mongo.ObjectId) ||
					patch.deletion._id.toHexString() !== patch.id ||
					(route
						? patch.deletion.kind !== 'alias'
						: color
							? typeof patch.deletion.name_en !== 'string'
							: product
								? patch.collection === 'product_variants' &&
									!['draft', 'archived'].includes(patch.deletion.status as string)
								: patch.deletion.status !== 'draft' ||
									(patch.collection === 'categories'
										? patch.deletion.attribute_contract_version !== 2
										: patch.deletion.contract_version !== 2))
				)
					throw new CatalogJournalError('INVALID_DELETION')
			}

			const target = `${patch.collection}:${patch.id}`
			if (targets.has(target)) throw new CatalogJournalError('DUPLICATE_TARGET')
			targets.add(target)
			for (const [field, change] of Object.entries(patch.fields)) {
				if (
					!(
						allowed[patch.collection].includes(field) ||
						(landing && LANDING_FIELDS.includes(field)) ||
						(settings && SETTINGS_FIELDS.includes(field)) ||
						(this.profile === 'seo' &&
							patch.collection === 'categories' &&
							['seo', 'updatedAt'].includes(field)) ||
						(color && COLOR_FIELDS.includes(field)) ||
						(this.profile === 'colors' &&
							patch.collection === 'product_variants' &&
							['color_family', 'name'].includes(field)) ||
						(this.profile === 'routes' &&
							['product_variants', 'categories', 'landings'].includes(
								patch.collection
							) &&
							['slug', 'updatedAt'].includes(field)) ||
						(this.profile === 'export' &&
							patch.collection === 'categories' &&
							['google_product_category', 'updatedAt'].includes(field)) ||
						// v1→v2 migration: explicit status, the brand entity link (Plan-0010 B04), the
						// product's own purchase notice and the colour of a single SKU put on the colour
						// axis (owner, 2026-11-05).
						(this.profile === 'migration' &&
							((patch.collection === 'categories' && field === 'status') ||
								(patch.collection === 'products' &&
									['brand_id', 'purchase_notice'].includes(field)) ||
								(patch.collection === 'product_variants' &&
									['color_id', 'color_family', 'v_value'].includes(field)))) ||
						(this.profile === 'conversion' &&
							((patch.collection === 'categories' &&
								['google_product_category', 'updatedAt'].includes(field)) ||
								(patch.collection === 'product_variants' && field === 'status') ||
								(patch.collection === 'landings' && field === 'updatedAt') ||
								(patch.collection === 'storefront_settings' &&
									['collections', 'updatedAt'].includes(field)))) ||
						// Publication changes lifecycle status only, never content (Plan-0010).
						(this.profile === 'publication' &&
							field === 'status' &&
							['categories', 'product_variants'].includes(patch.collection)) ||
						(this.profile === 'draft-product-details' &&
							((patch.collection === 'products' &&
								['description', 'purchase_notice', 'vendor_id'].includes(field)) ||
								(patch.collection === 'product_variants' &&
									[
										'price',
										'stock',
										'weight_g',
										'images',
										'price_updated_at',
										'stock_updated_at',
										'status',
										// Recolouring a colour-axis SKU keeps the legacy colour fields.
										'color_id',
										'color_family',
										'v_value',
										// Supplier identifiers, as the old admin's variant form.
										'vendor_product_sku',
										'prom_id',
										// The SKU's promotion (TD-0012), as the old admin's form.
										'promo_percent',
										'promo_ends_at'
									].includes(field))))
					) ||
					!change
				)
					throw new CatalogJournalError('FORBIDDEN_FIELD')
				for (const image of [change.before, change.after]) {
					if (
						!image ||
						typeof image.exists !== 'boolean' ||
						(image.exists &&
							(!Object.hasOwn(image, 'value') || image.value === undefined))
					)
						throw new CatalogJournalError('INVALID_IMAGE')
				}
			}
		}
		let plan: Plan = {
			_id: token.operationId,
			token,
			patches,
			phase: 'prepared',
			checkpoint: 0
		}
		if (mongo.BSON.calculateObjectSize(plan) > PLAN_MAX_BYTES)
			throw new CatalogJournalError('PLAN_TOO_LARGE')
		// Own the BSON snapshot before awaiting reads; reject lossy values such as undefined.
		const snapshot = mongo.BSON.deserialize(mongo.BSON.serialize(plan)) as Plan
		if (!isDeepStrictEqual(plan, snapshot)) throw new CatalogJournalError('INVALID_IMAGE')
		plan = snapshot
		patches = snapshot.patches
		// Snapshot checking precedes preparation; the shared writer gate serializes domain writers.
		// SKUs removed by this same plan (before their product) are not references to it.
		const removedInPlan = patches
			.filter(patch => patch.deletion && patch.collection === 'product_variants')
			.map(patch => new mongo.ObjectId(patch.id))
		await this.checkEach(patches, async patch => {
			await this.assertImage(patch, 'before')
			if (patch.deletion) await this.assertUnused(patch, removedInPlan)
		})
		try {
			await this.plans.insertOne(plan)
		} catch (error) {
			if ((error as { code?: number }).code !== 11000) throw error
			const existing = await this.plans.findOne({ _id: token.operationId })
			if (
				!existing ||
				!isDeepStrictEqual(existing.token, token) ||
				!isDeepStrictEqual(existing.patches, patches)
			)
				throw new CatalogJournalError('PLAN_CONFLICT')
		}
	}

	/** No token is disclosed: safe summary for operator inspection before any recovery write. */
	async inspect(operationId: string) {
		const plan = await this.plans.findOne({ _id: operationId }, { readPreference: 'primary' })
		if (!plan) throw new CatalogJournalError('PLAN_MISSING')
		const counts = { before: 0, after: 0, both: 0, conflict: 0, missing: 0 }
		await this.checkEach(plan.patches, async patch => {
			try {
				const before = await this.matches(patch, 'before')
				const after = await this.matches(patch, 'after')
				counts[
					before && after ? 'both' : before ? 'before' : after ? 'after' : 'conflict'
				]++
			} catch (error) {
				if (!(error instanceof CatalogJournalError) || error.code !== 'TARGET_MISSING')
					throw error
				counts.missing++
			}
		})
		return { phase: plan.phase, targets: plan.patches.length, counts }
	}

	/** Restartable adoption while the gate is closed in recovering phase. */
	async adoptRecovery(previous: CatalogWriteToken, next: CatalogWriteToken): Promise<void> {
		await this.gate.assertRecovering(previous, next)
		const summary = await this.inspect(previous.operationId)
		if (summary.counts.conflict || summary.counts.missing)
			throw new CatalogJournalError('RECOVERY_CONFLICT')
		const result = await this.plans.updateOne(
			{ _id: previous.operationId, $or: [{ token: previous }, { token: next }] },
			{ $set: { token: next } }
		)
		if (!result.matchedCount) throw new CatalogJournalError('PLAN_CONFLICT')
	}

	/**
	 * Runs a read-only check of every target, `READ_BATCH` at a time. The failure reported is the
	 * one a walk in plan order would have met first: batches go in order, and within a batch the
	 * earliest target that failed is thrown. Never for writes.
	 */
	private async checkEach(
		patches: CatalogPatch[],
		check: (patch: CatalogPatch) => Promise<void>
	): Promise<void> {
		for (let start = 0; start < patches.length; start += READ_BATCH) {
			const results = await Promise.allSettled(
				patches.slice(start, start + READ_BATCH).map(check)
			)
			const failed = results.find(result => result.status === 'rejected')
			if (failed) throw failed.reason
		}
	}

	private collection(patch: CatalogPatch) {
		return this.db.collection(patch.collection, {
			writeConcern: { w: 1, j: true },
			readPreference: 'primary'
		})
	}
	private async matches(patch: CatalogPatch, side: 'before' | 'after'): Promise<boolean> {
		const document = await this.collection(patch).findOne({ _id: new mongo.ObjectId(patch.id) })
		if (patch.creation)
			return side === 'before'
				? document === null
				: isDeepStrictEqual(document, patch.creation)
		if (patch.deletion)
			return side === 'after'
				? document === null
				: isDeepStrictEqual(document, patch.deletion)
		if (!document) throw new CatalogJournalError('TARGET_MISSING')
		return Object.entries(patch.fields).every(([key, images]) => {
			const image = images[side]
			return image.exists
				? Object.hasOwn(document, key) && isDeepStrictEqual(document[key], image.value)
				: !Object.hasOwn(document, key)
		})
	}
	private async assertImage(patch: CatalogPatch, side: 'before' | 'after') {
		if (!(await this.matches(patch, side))) throw new CatalogJournalError('RECOVERY_CONFLICT')
	}

	/** Only under the shared writer gate; independent, uncooperative writes are not fenced. */
	private async assertUnused(
		patch: CatalogPatch,
		removedInPlan: mongo.ObjectId[] = []
	): Promise<void> {
		// An alias is an address, not data anything points at.
		if (patch.collection === 'catalog_routes') return
		if (patch.collection === 'colors') {
			// A colour SKUs point at: removing it would strand `color_id` and freeze `color_family`.
			const ids = [new mongo.ObjectId(patch.id), patch.id]
			if (
				await this.db
					.collection('product_variants')
					.findOne(
						{ color_id: { $in: ids } },
						{ projection: { _id: 1 }, readPreference: 'primary' }
					)
			)
				throw new CatalogJournalError('COLOR_IN_USE')
			return
		}
		if (patch.collection === 'landings') {
			const ids = [new mongo.ObjectId(patch.id), patch.id]
			if (
				await this.db
					.collection('storefront_settings')
					.findOne(
						{ 'collections.landing_id': { $in: ids } },
						{ projection: { _id: 1 }, readPreference: 'primary' }
					)
			)
				throw new CatalogJournalError('LANDING_IN_USE')
			return
		}
		if (patch.collection !== 'categories')
			return this.assertCreatedProductUnused(patch, removedInPlan)
		const ids = [new mongo.ObjectId(patch.id), patch.id]
		const references: [string, mongo.Filter<mongo.Document>][] = [
			['categories', { parent_id: { $in: ids } }],
			['products', { category_id: { $in: ids } }],
			['product_variants', { category_id: { $in: ids } }],
			['landings', { category_id: { $in: ids } }],
			['catalog_routes', { entity_type: 'category', entity_id: { $in: ids } }],
			['storefront_settings', { 'collections.category_id': { $in: ids } }]
		]
		for (const [collection, filter] of references) {
			if (
				await this.db
					.collection(collection)
					.findOne(filter, { projection: { _id: 1 }, readPreference: 'primary' })
			)
				throw new CatalogJournalError(
					patch.deletion ? 'CATEGORY_IN_USE' : 'CREATED_CATEGORY_IN_USE'
				)
		}
	}

	private async assertCreatedProductUnused(
		patch: CatalogPatch,
		removedInPlan: mongo.ObjectId[] = []
	): Promise<void> {
		const ids = [new mongo.ObjectId(patch.id), patch.id]
		const references: [string, mongo.Filter<mongo.Document>][] =
			patch.collection === 'products'
				? [
						[
							'product_variants',
							{ product_id: { $in: ids }, _id: { $nin: removedInPlan } }
						],
						['orders', { 'items.product_id': { $in: ids } }],
						// A curated storefront collection that lists it (Plan-0010 B09).
						['storefront_settings', { 'collections.product_ids': { $in: ids } }]
					]
				: [
						['carts', { 'items.variant_id': { $in: ids } }],
						['orders', { 'items.variant_id': { $in: ids } }]
					]
		references.push([
			'catalog_routes',
			{
				entity_type: patch.collection === 'products' ? 'product' : 'variant',
				entity_id: { $in: ids }
			}
		])
		for (const [collection, filter] of references)
			if (
				await this.db
					.collection(collection)
					.findOne(filter, { projection: { _id: 1 }, readPreference: 'primary' })
			)
				throw new CatalogJournalError(
					patch.deletion ? 'PRODUCT_IN_USE' : 'CREATED_PRODUCT_IN_USE'
				)
	}

	private async writeLifecycle(patch: CatalogPatch, direction: 'apply' | 'rollback') {
		const image = patch.creation ?? patch.deletion!
		const inserting = patch.creation ? direction === 'apply' : direction === 'rollback'
		if (inserting) {
			if (patch.deletion && patch.collection === 'catalog_routes') {
				// A reclaimed old address must still be free to come back.
				const conflict = await this.collection(patch).findOne({ path: image.path })
				if (conflict) throw new CatalogJournalError('RECOVERY_CONFLICT')
			} else if (patch.deletion && patch.collection === 'product_variants') {
				// A SKU comes back only to its own code and address.
				const conflict = await this.collection(patch).findOne({
					$or: [{ sku: image.sku }, { slug: image.slug }]
				})
				if (conflict) throw new CatalogJournalError('RECOVERY_CONFLICT')
			} else if (patch.deletion && patch.collection === 'products') {
				// Identity is the _id alone (a duplicate insert below is the conflict).
			} else if (patch.deletion && patch.collection === 'colors') {
				// A colour's identity is its slug and canonical English name (both unique).
				const conflict = await this.collection(patch).findOne({
					$or: [{ slug: image.slug }, { name_en: image.name_en }]
				})
				if (conflict) throw new CatalogJournalError('RECOVERY_CONFLICT')
			} else if (patch.deletion && patch.collection === 'landings') {
				// A landing's identity is its address inside the category.
				const conflict = await this.collection(patch).findOne({
					category_id: image.category_id,
					slug: image.slug
				})
				if (conflict) throw new CatalogJournalError('RECOVERY_CONFLICT')
			} else if (patch.deletion) {
				// Recovery must not recreate a conflicting identity or an orphaned child.
				const conflict = await this.collection(patch).findOne({
					$or: [{ name: image.name }, { slug: image.slug }]
				})
				if (conflict) throw new CatalogJournalError('RECOVERY_CONFLICT')
				if (image.parent_id != null) {
					const parent = await this.collection(patch).findOne({
						_id: new mongo.ObjectId(String(image.parent_id)),
						kind: 'group',
						attribute_contract_version: 2
					})
					if (!parent) throw new CatalogJournalError('RECOVERY_CONFLICT')
				}
			}
			try {
				await this.collection(patch).insertOne(image)
			} catch (error) {
				if ((error as { code?: number }).code !== 11000) throw error
				throw new CatalogJournalError('RECOVERY_CONFLICT')
			}
		} else {
			await this.assertUnused(patch)
			const result = await this.collection(patch).deleteOne({
				_id: new mongo.ObjectId(patch.id),
				$expr: { $eq: ['$$ROOT', { $literal: image }] }
			})
			if (!result.deletedCount) throw new CatalogJournalError('RECOVERY_CONFLICT')
		}
	}

	async execute(token: CatalogWriteToken, direction: 'apply' | 'rollback'): Promise<void> {
		await this.gate.assertWriting(token)
		const plan = await this.plans.findOne(
			{ _id: token.operationId },
			{ readPreference: 'primary' }
		)
		if (!plan || !isDeepStrictEqual(plan.token, token))
			throw new CatalogJournalError('PLAN_MISSING')
		if (direction === 'apply' && ['rolling_back', 'rolled_back'].includes(plan.phase))
			throw new CatalogJournalError('ROLLBACK_ALREADY_SELECTED')
		const from = direction === 'apply' ? 'before' : 'after'
		const to = direction === 'apply' ? 'after' : 'before'
		// Check EVERY target before making any new writes, including on resume.
		await this.checkEach(plan.patches, async patch => {
			if (!(await this.matches(patch, from)) && !(await this.matches(patch, to)))
				throw new CatalogJournalError('RECOVERY_CONFLICT')
		})
		await this.plans.updateOne(
			{ _id: plan._id },
			{ $set: { phase: direction === 'apply' ? 'applying' : 'rolling_back' } }
		)
		await this.gate.beginDomainWrites(token)
		const ordered = direction === 'apply' ? plan.patches : [...plan.patches].reverse()
		for (const [index, patch] of ordered.entries()) {
			await this.gate.assertWriting(token)
			// Also verify an already absent target after a lost delete acknowledgement.
			if (
				(patch.deletion && direction === 'apply') ||
				(patch.creation && direction === 'rollback')
			)
				await this.assertUnused(patch)
			if (!(await this.matches(patch, to))) {
				if (patch.creation || patch.deletion) {
					await this.writeLifecycle(patch, direction)
				} else {
					const clauses: mongo.Document[] = []
					const set: mongo.Document = {},
						unset: mongo.Document = {}
					for (const [key, images] of Object.entries(patch.fields)) {
						const source = images[from],
							target = images[to]
						clauses.push(
							source.exists
								? {
										$and: [
											{ $ne: [{ $type: `$${key}` }, 'missing'] },
											{ $eq: [`$${key}`, { $literal: source.value }] }
										]
									}
								: { $eq: [{ $type: `$${key}` }, 'missing'] }
						)
						if (target.exists) set[key] = target.value
						else unset[key] = ''
					}
					const update: mongo.Document = {}
					if (Object.keys(set).length) update.$set = set
					if (Object.keys(unset).length) update.$unset = unset
					const result = await this.collection(patch).updateOne(
						{ _id: new mongo.ObjectId(patch.id), $expr: { $and: clauses } },
						update
					)
					if (!result.matchedCount) throw new CatalogJournalError('RECOVERY_CONFLICT')
				}
			}
			await this.plans.updateOne({ _id: plan._id }, { $set: { checkpoint: index + 1 } })
		}
		await this.checkEach(plan.patches, patch => this.assertImage(patch, to))
		await this.plans.updateOne(
			{ _id: plan._id },
			{ $set: { phase: direction === 'apply' ? 'applied' : 'rolled_back' } }
		)
		// Gate stays closed. Caller validates domain invariants, then publishes or finishes rollback.
	}
}
