import { isDeepStrictEqual } from 'node:util'
import { sanitizeRichText } from 'src/common/utils/html.utils'
import { resolvePromoPatch } from './promo-pricing'
import { supplierPriceOf } from 'src/modules/prom/prom-pricing'
import { createHash } from 'node:crypto'
import { mongo } from 'mongoose'
import { z } from 'zod'
import {
	CatalogWriteGate,
	CatalogGateError
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { readCategoryConfiguration } from '../category/category-configuration'
import { productReadiness } from './product-readiness'
import { ProductIdentityAllocator } from './product-identity-allocator'
import {
	type PurchaseNotice,
	assertReady,
	supplierIdValue,
	typedProductEditSchema,
	validateTypedProduct,
	TypedProductError
} from './typed-product'
import { loadAxisColors } from './typed-product-colors'

/**
 * Characteristics keep the order they are stored in; only new keys are appended (in the
 * validated, definition order). Re-sorting on every save made an unchanged product differ from
 * its stored image: the partner card order moved although no value had changed.
 */
export function keepStoredOrder<T extends { k: string }>(stored: unknown, next: T[]): T[] {
	const order = new Map<string, number>()
	if (Array.isArray(stored))
		for (const row of stored as { k?: unknown }[])
			if (typeof row?.k === 'string' && !order.has(row.k)) order.set(row.k, order.size)
	return next
		.map((row, index) => ({ row, rank: order.get(row.k) ?? order.size + index }))
		.sort((a, b) => a.rank - b.rank)
		.map(item => item.row)
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/)
const requestSchema = z.strictObject({
	operationId: z.string().uuid(),
	ownerId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative().safe()
})
/**
 * Anything that would outlive a removed product or SKU: an order or cart line, a typed relation,
 * an old-address alias. The journal checks the same again under the gate; this answers first
 * with a precise code instead of a generic conflict.
 */
async function assertNeverSold(db: mongo.Db, kind: 'product' | 'variant', id: mongo.ObjectId) {
	const ids = [id, String(id)]
	const checks: [string, mongo.Filter<mongo.Document>][] =
		kind === 'variant'
			? [
					['orders', { 'items.variant_id': { $in: ids } }],
					['carts', { 'items.variant_id': { $in: ids } }],
					['catalog_routes', { entity_type: 'variant', entity_id: { $in: ids } }]
				]
			: [
					['orders', { 'items.product_id': { $in: ids } }],
					['catalog_routes', { entity_type: 'product', entity_id: { $in: ids } }],
					// A curated storefront collection that lists it (Plan-0010 B09) — the journal's
					// last check too, but refused here it is a 409 the admin can read, not a 503.
					['storefront_settings', { 'collections.product_ids': { $in: ids } }]
				]
	for (const [collection, filter] of checks)
		if (
			await db
				.collection(collection)
				.findOne(filter, { projection: { _id: 1 }, readPreference: 'primary' })
		)
			throw new TypedProductError(kind === 'variant' ? 'VARIANT_IN_USE' : 'PRODUCT_IN_USE')
}

export class TypedProductWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'draft-product-details')
	}
	private async snapshot(id: string) {
		const product = await this.db
			.collection('products')
			.findOne({ _id: new mongo.ObjectId(id) }, { readPreference: 'primary' })
		if (!product) throw new TypedProductError('PRODUCT_NOT_FOUND')
		if (!(product.category_id instanceof mongo.ObjectId))
			throw new TypedProductError('TYPED_PRODUCT_DATA_UNAVAILABLE')
		const category = await this.db
			.collection('categories')
			.findOne({ _id: product.category_id }, { readPreference: 'primary' })
		if (!category) throw new TypedProductError('CATEGORY_NOT_FOUND')
		const config = readCategoryConfiguration({
			...category,
			parent_id: category.parent_id == null ? null : String(category.parent_id)
		})
		if (config.attribute_contract_version !== 2 || config.kind !== 'product')
			throw new TypedProductError('CATALOG_CONTRACT_UPGRADE_REQUIRED')
		// A published category's products are edited in place (owner decision 2026-10-27).
		if (category.status !== 'draft' && category.status !== 'active')
			throw new TypedProductError('PRODUCT_EDIT_REQUIRES_DRAFT')
		const published = category.status === 'active'
		const variants = await this.db
			.collection('product_variants')
			.find({ product_id: { $in: [product._id, id] } }, { readPreference: 'primary' })
			.sort({ _id: 1 })
			.limit(101)
			.toArray()
		if (!variants.length || variants.length > 100)
			throw new TypedProductError('PRODUCT_VARIANT_LIMIT')
		if (variants.some(row => !['draft', 'active', 'archived'].includes(row.status as string)))
			throw new TypedProductError('PRODUCT_EDIT_REQUIRES_DRAFT')
		const definitions = config.attribute_definitions!
		const axisKey = (product.variant_axis as { key?: string } | null | undefined)?.key
		const colorAxis =
			definitions.find(definition => definition.key === axisKey)?.semantic === 'color'
		// A colour axis stores the dictionary id; any other SKU must not carry a dictionary colour.
		if (
			variants.some(row =>
				colorAxis
					? !(row.color_id instanceof mongo.ObjectId) ||
						row.variant_value !== String(row.color_id)
					: row.color_id != null
			)
		)
			throw new TypedProductError(
				colorAxis ? 'TYPED_PRODUCT_DATA_UNAVAILABLE' : 'COLOR_ADAPTER_REQUIRED'
			)
		if (
			variants.some(
				row =>
					String(row.category_id) !== String(product.category_id) ||
					typeof row.slug !== 'string' ||
					!row.slug ||
					typeof row.sku !== 'string' ||
					!row.sku
			)
		)
			throw new TypedProductError('TYPED_PRODUCT_DATA_UNAVAILABLE')
		const colors = await loadAxisColors(
			this.db,
			colorAxis ? variants.map(row => row.variant_value as unknown) : []
		)
		const value = validateTypedProduct(
			definitions,
			{
				name: product.name as unknown,
				attributes_v2: product.attributes_v2 as unknown,
				variant_axis: product.variant_axis as unknown,
				variants: variants.map(row => ({
					id: String(row._id),
					variant_value: row.variant_value as unknown
				}))
			},
			{ labelFor: value => colors.get(String(value))?.label ?? null }
		)
		return { product, variants, definitions, value, published, colorAxis }
	}
	/**
	 * One page of a category's products for the admin, in creation order: by an opaque cursor (the
	 * collection picker) or by number with the total (the products screen, owner 2026-11-03), and
	 * optionally narrowed by name — over the whole category, literally, case-insensitive.
	 */
	async list(categoryId: string, cursor?: string, view: { page?: number; q?: string } = {}) {
		objectId.parse(categoryId)
		const stamp = await this.gate.readStamp()
		let after: string | undefined
		if (cursor) {
			let decoded: unknown
			try {
				decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
			} catch {
				throw new TypedProductError('INVALID_PRODUCT_CURSOR')
			}
			const parsed = z
				.strictObject({
					category_id: objectId,
					revision: z.number().int(),
					epoch: z.number().int(),
					after: objectId
				})
				.safeParse(decoded)
			if (!parsed.success) throw new TypedProductError('INVALID_PRODUCT_CURSOR')
			if (
				parsed.data.category_id !== categoryId ||
				parsed.data.revision !== stamp.revision ||
				parsed.data.epoch !== stamp.epoch
			)
				throw new TypedProductError('PRODUCT_CURSOR_CHANGED')
			after = parsed.data.after
		}
		const category = await this.db
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(categoryId) }, { readPreference: 'primary' })
		if (!category) throw new TypedProductError('CATEGORY_NOT_FOUND')
		if (category.attribute_contract_version !== 2 || category.kind !== 'product')
			throw new TypedProductError('CATALOG_CONTRACT_UPGRADE_REQUIRED')
		if (category.status !== 'draft' && category.status !== 'active')
			throw new TypedProductError('PRODUCT_EDIT_REQUIRES_DRAFT')
		const filter: mongo.Filter<mongo.Document> = {
			category_id: new mongo.ObjectId(categoryId),
			...(view.q
				? { name: { $regex: view.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
				: {})
		}
		const products = this.db.collection('products')
		const [rows, total] = await Promise.all([
			products
				.find(
					{ ...filter, ...(after ? { _id: { $gt: new mongo.ObjectId(after) } } : {}) },
					{ readPreference: 'primary', projection: { _id: 1, name: 1 } }
				)
				.sort({ _id: 1 })
				.skip(view.page ? (view.page - 1) * 25 : 0)
				.limit(26)
				.toArray(),
			products.countDocuments(filter, { readPreference: 'primary' })
		])
		if (rows.some(row => typeof row.name !== 'string' || !row.name))
			throw new TypedProductError('TYPED_PRODUCT_DATA_UNAVAILABLE')
		await this.gate.assertReadUnchanged(stamp)
		const page = rows.slice(0, 25)
		return {
			category_id: categoryId,
			revision: stamp.revision,
			items: page.map(row => ({ id: String(row._id), name: row.name as string })),
			total,
			next_cursor:
				rows.length > 25
					? Buffer.from(
							JSON.stringify({
								category_id: categoryId,
								...stamp,
								after: String(page.at(-1)!._id)
							})
						).toString('base64url')
					: null
		}
	}

	private details(snapshot: Awaited<ReturnType<TypedProductWriter['snapshot']>>) {
		const fields = [
			'price',
			'stock',
			'weight_g',
			'images',
			'price_updated_at',
			'stock_updated_at',
			'vendor_product_sku',
			'prom_id',
			'promo_percent',
			'promo_ends_at'
		]
		const raw = {
			description: snapshot.product.description as unknown,
			purchase_notice: (snapshot.product.purchase_notice ?? null) as unknown,
			variants: snapshot.variants.map(row => ({
				id: String(row._id),
				...Object.fromEntries(fields.map(key => [key, row[key] as unknown]))
			}))
		}
		return {
			token: createHash('sha256').update(mongo.BSON.serialize(raw)).digest('hex'),
			description:
				snapshot.product.description == null
					? null
					: (snapshot.product.description as {
							html: string
							json: Record<string, unknown>
						}),
			purchase_notice: (snapshot.product.purchase_notice ?? null) as PurchaseNotice,
			variants: snapshot.variants.map(row => ({
				id: String(row._id),
				price: row.price as number,
				stock: row.stock as number,
				weight_g: (row.weight_g ?? null) as number | null,
				// Admin-only supplier identifiers; `prom_id` keys the Prom price/stock sync.
				vendor_product_sku: (row.vendor_product_sku ?? null) as string | null,
				prom_id: (row.prom_id ?? null) as string | null,
				// Stored as set, even after its end date: the editor tells a live promotion from an
				// ended one (it must not resend a past end date), as the old admin's form did.
				promo_percent: (row.promo_percent ?? null) as number | null,
				promo_ends_at:
					row.promo_ends_at instanceof Date ? row.promo_ends_at.toISOString() : null,
				images: (row.images ?? []) as string[]
			}))
		}
	}
	async read(id: string) {
		objectId.parse(id)
		const stamp = await this.gate.readStamp()
		const snapshot = await this.snapshot(id)
		await this.gate.assertReadUnchanged(stamp)
		return {
			product_id: id,
			category_id: String(snapshot.product.category_id),
			vendor_id:
				snapshot.product.vendor_id == null ? null : String(snapshot.product.vendor_id),
			published: snapshot.published,
			color_axis: snapshot.colorAxis,
			revision: stamp.revision,
			definitions: snapshot.definitions,
			details: this.details(snapshot),
			readiness: productReadiness({
				definitions: snapshot.definitions,
				attributes: snapshot.value.attributes_v2,
				axisKey: snapshot.value.variant_axis?.key,
				description: snapshot.product.description as unknown,
				variants: snapshot.variants.map(row => ({
					id: String(row._id),
					status: row.status as string,
					price: row.price as unknown,
					stock: row.stock as unknown,
					images: row.images as unknown,
					weight_g: row.weight_g as unknown
				}))
			}),
			...snapshot.value,
			variants: snapshot.value.variants.map((variant, index) => ({
				...variant,
				slug: snapshot.variants[index].slug as string,
				sku: snapshot.variants[index].sku as string,
				status: snapshot.variants[index].status as 'draft' | 'active' | 'archived',
				// What the shop pays (read only, outside `details` so a round trip stays valid):
				// the editor warns about a promotion below cost and never blocks it.
				supplier_price: supplierPriceOf(
					snapshot.variants[index] as { prom_base_price?: number | null }
				)
			}))
		}
	}
	/**
	 * Remove a product the shop never sold, with all its SKUs (the old admin's «Видалити»,
	 * made safe): none may be active — archive first, the page then leaves the storefront by
	 * the archive rules — and nothing may point at it (orders, carts, old addresses).
	 */
	async remove(request: z.infer<typeof requestSchema>, id: string) {
		request = requestSchema.parse(request)
		objectId.parse(id)
		const hash = createHash('sha256')
			.update(
				mongo.BSON.serialize({
					type: 'typed-product-delete',
					id,
					expected_revision: request.expectedRevision
				})
			)
			.digest('hex')
		const enabled = () =>
			this.db
				.collection<{ _id: string }>('catalog_control')
				.findOne({ _id: 'catalog', admin_draft_writes_enabled: true })
		if (!(await enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
		const receipt = (revision: number) => ({
			operation_id: request.operationId,
			revision,
			product_id: id
		})
		const previous = await this.gate.operation(request.operationId)
		if (previous) {
			if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			if (previous.status === 'completed' && previous.revision !== undefined)
				return receipt(previous.revision)
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}
		const token = await this.gate.acquire(
			request.operationId,
			hash,
			request.ownerId,
			request.expectedRevision
		)
		let started = false
		try {
			if (!(await enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
			const snapshot = await this.snapshot(id)
			if (snapshot.variants.some(row => row.status === 'active'))
				throw new TypedProductError('PRODUCT_DELETE_REQUIRES_INACTIVE')
			await assertNeverSold(this.db, 'product', snapshot.product._id)
			for (const row of snapshot.variants) await assertNeverSold(this.db, 'variant', row._id)
			// SKUs first: the journal refuses to remove a product its SKUs still point at.
			const patches: CatalogPatch[] = [
				...snapshot.variants.map(row => ({
					collection: 'product_variants' as const,
					id: String(row._id),
					fields: {},
					deletion: row
				})),
				{ collection: 'products', id, fields: {}, deletion: snapshot.product }
			]
			await this.journal.prepare(token, patches)
			started = true
			await this.journal.execute(token, 'apply')
			const inspection = await this.journal.inspect(request.operationId)
			if (inspection.counts.after !== patches.length)
				throw Error('PRODUCT_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			return receipt(token.revision + 1)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}

	async edit(request: z.infer<typeof requestSchema>, id: string, input: unknown) {
		request = requestSchema.parse(request)
		objectId.parse(id)
		const command = typedProductEditSchema.parse(input)
		const hash = createHash('sha256')
			.update(
				mongo.BSON.serialize({
					type: 'typed-product-edit',
					id,
					expected_revision: request.expectedRevision,
					command
				})
			)
			.digest('hex')
		const enabled = await this.db
			.collection<{ _id: string }>('catalog_control')
			.findOne({ _id: 'catalog', admin_draft_writes_enabled: true })
		if (!enabled) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
		const previous = await this.gate.operation(request.operationId)
		const receipt = (revision: number) => ({
			operation_id: request.operationId,
			revision,
			product_id: id
		})
		if (previous) {
			if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			if (previous.status === 'completed' && previous.revision !== undefined)
				return receipt(previous.revision)
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}
		const token = await this.gate.acquire(
			request.operationId,
			hash,
			request.ownerId,
			request.expectedRevision
		)
		let started = false
		try {
			if (
				!(await this.db
					.collection<{ _id: string }>('catalog_control')
					.findOne({ _id: 'catalog', admin_draft_writes_enabled: true }))
			)
				throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
			const snapshot = await this.snapshot(id)
			const action = command.variant_action
			// Dictionary colours of every axis value in the command (none without a colour axis).
			const colors = await loadAxisColors(
				this.db,
				snapshot.colorAxis
					? [
							...command.variants.map(row => row.variant_value),
							...(action?.type === 'add' ? [action.variant_value] : [])
						]
					: []
			)
			const labelFor = (value: string | number | boolean) =>
				colors.get(String(value))?.label ?? null
			// A published product keeps every required characteristic; a draft may be incomplete.
			const next = validateTypedProduct(snapshot.definitions, command, {
				active: snapshot.published,
				labelFor
			})
			if (command.details && command.details.token !== this.details(snapshot).token)
				throw new TypedProductError('PRODUCT_DETAILS_CHANGED')
			const byId = new Map(snapshot.variants.map(row => [String(row._id), row]))
			if (next.variants.length !== byId.size || next.variants.some(row => !byId.has(row.id)))
				throw new TypedProductError('VARIANT_SET_CHANGED')
			const patch = (
				collection: CatalogPatch['collection'],
				row: mongo.Document,
				fields: Record<string, unknown>
			): CatalogPatch => ({
				collection,
				id: String(row._id),
				fields: Object.fromEntries(
					Object.entries(fields).map(([key, value]) => [
						key,
						{
							before: Object.hasOwn(row, key)
								? { exists: true, value: row[key] as unknown }
								: { exists: false },
							after: { exists: true, value }
						}
					])
				)
			})
			const vendor =
				command.vendor_id !== undefined &&
				String(snapshot.product.vendor_id ?? '') !== command.vendor_id
					? new mongo.ObjectId(command.vendor_id)
					: undefined
			if (
				vendor &&
				!(await this.db
					.collection('vendors')
					.findOne(
						{ _id: vendor },
						{ readPreference: 'primary', projection: { _id: 1 } }
					))
			)
				throw new TypedProductError('VENDOR_NOT_FOUND')
			const patches: CatalogPatch[] = [
				patch('products', snapshot.product, {
					...(vendor ? { vendor_id: vendor } : {}),
					name: next.name,
					attributes_v2: keepStoredOrder(
						snapshot.product.attributes_v2,
						next.attributes_v2
					),
					variant_axis: next.variant_axis
				}),
				...next.variants.map(row => {
					const color = snapshot.colorAxis ? colors.get(String(row.variant_value)) : null
					return patch('product_variants', byId.get(row.id)!, {
						name: row.name,
						variant_value: row.variant_value,
						// A recoloured SKU keeps the legacy colour fields every reader still uses.
						...(color
							? {
									color_id: color.id,
									color_family: color.family,
									v_value: color.name_en
								}
							: {})
					})
				})
			]
			if (command.details) {
				const details = command.details
				if (
					details.variants.length !== byId.size ||
					new Set(details.variants.map(row => row.id)).size !== byId.size ||
					details.variants.some(row => !byId.has(row.id))
				)
					throw new TypedProductError('VARIANT_SET_CHANGED')
				const description = details.description
					? { ...details.description, html: sanitizeRichText(details.description.html) }
					: null
				if (!isDeepStrictEqual(snapshot.product.description ?? null, description))
					Object.assign(
						patches[0].fields,
						patch('products', snapshot.product, { description }).fields
					)
				const notice = details.purchase_notice
				if (
					notice !== undefined &&
					!isDeepStrictEqual(snapshot.product.purchase_notice ?? null, notice)
				)
					Object.assign(
						patches[0].fields,
						patch('products', snapshot.product, { purchase_notice: notice }).fields
					)
				for (const detail of details.variants) {
					const previous = byId.get(detail.id)!
					const changed: Record<string, unknown> = {}
					for (const field of ['price', 'stock', 'weight_g', 'images'] as const) {
						const before: unknown = previous[field] ?? (field === 'images' ? [] : null)
						if (!isDeepStrictEqual(before, detail[field]))
							changed[field] = detail[field]
					}
					for (const field of ['vendor_product_sku', 'prom_id'] as const) {
						const after = supplierIdValue(detail[field])
						if (after !== undefined && (previous[field] ?? null) !== after)
							changed[field] = after
					}
					// The SKU's promotion, by the shared TD-0012 rule (a stale end date is cleared
					// when a new percent arrives without one; a past end date is refused).
					// Values sent back as read are no change: an ended promotion's past end date,
					// resent unchanged, must not refuse the whole save (the old admin's trap).
					const storedPercent = (previous.promo_percent ?? null) as number | null
					const storedEnd =
						previous.promo_ends_at instanceof Date ? previous.promo_ends_at : null
					const sentEnd =
						detail.promo_ends_at == null
							? detail.promo_ends_at
							: new Date(detail.promo_ends_at)
					const promo = resolvePromoPatch(
						{
							promo_percent:
								detail.promo_percent === storedPercent
									? undefined
									: detail.promo_percent,
							promo_ends_at:
								sentEnd === undefined ||
								(sentEnd === null
									? storedEnd === null
									: storedEnd?.getTime() === sentEnd.getTime())
									? undefined
									: detail.promo_ends_at
						},
						{ promo_percent: storedPercent, promo_ends_at: storedEnd }
					)
					for (const field of ['promo_percent', 'promo_ends_at'] as const)
						if (
							Object.hasOwn(promo, field) &&
							!isDeepStrictEqual(previous[field] ?? null, promo[field] ?? null)
						)
							changed[field] = promo[field] ?? null
					if (Object.hasOwn(changed, 'price')) changed.price_updated_at = new Date()
					if (Object.hasOwn(changed, 'stock')) changed.stock_updated_at = new Date()
					const target = patches.find(
						item => item.collection === 'product_variants' && item.id === detail.id
					)!
					if (Object.keys(changed).length)
						Object.assign(
							target.fields,
							patch('product_variants', previous, changed).fields
						)
				}
			}

			// A SKU that this save turns active is judged as the save leaves the product: its
			// description, characteristics and that SKU's price, stock and photos (owner, 2026-11-15).
			// Nothing else is: a save of a SKU that is already active passes as before.
			const activate = (sku: {
				id: string
				price: unknown
				stock: unknown
				images: unknown
				weight_g: unknown
			}) =>
				assertReady({
					definitions: snapshot.definitions,
					attributes: next.attributes_v2,
					axisKey: next.variant_axis?.key,
					description: command.details
						? command.details.description && {
								...command.details.description,
								html: sanitizeRichText(command.details.description.html)
							}
						: (snapshot.product.description as unknown),
					variants: [{ ...sku, status: 'active' }]
				})
			if (action) {
				if (action.type === 'add') {
					const status = action.status ?? 'draft'
					if (status === 'active' && !snapshot.published)
						throw new TypedProductError('VARIANT_STATUS_CONFLICT')
					if (!next.variant_axis) throw new TypedProductError('VARIANT_AXIS_REQUIRED')
					if (next.variants.length >= 100)
						throw new TypedProductError('PRODUCT_VARIANT_LIMIT')
					const variantId = createHash('sha256')
						.update(`typed-variant-add:${request.operationId}`)
						.digest('hex')
						.slice(0, 24)
					const checked = validateTypedProduct(
						snapshot.definitions,
						{
							...command,
							variants: [
								...command.variants,
								{ id: variantId, variant_value: action.variant_value }
							]
						},
						{ labelFor }
					)
					const addedColor = snapshot.colorAxis
						? colors.get(String(action.variant_value))
						: undefined
					const added = checked.variants.at(-1)!
					if (status === 'active')
						activate({
							id: variantId,
							price: action.price,
							stock: action.stock,
							images: action.images ?? [],
							weight_g: action.weight_g
						})
					const allocator = new ProductIdentityAllocator(this.db)
					await allocator.requireIndexes()
					const [sku] = await allocator.reserveSkus(1)
					if (await this.db.collection('product_variants').findOne({ sku }))
						throw new TypedProductError('SKU_COUNTER_CONFLICT')
					const slug = await allocator.allocate(added.name, sku)
					const now = new Date()
					patches.push({
						collection: 'product_variants',
						id: variantId,
						fields: {},
						creation: {
							_id: new mongo.ObjectId(variantId),
							product_id: snapshot.product._id,
							category_id: snapshot.product.category_id as mongo.ObjectId,
							name: added.name,
							variant_value: added.variant_value,
							sku,
							slug,
							// As the old admin: the supplier's article if given, else our SKU.
							vendor_product_sku: supplierIdValue(action.vendor_product_sku) ?? sku,
							prom_id: supplierIdValue(action.prom_id) ?? null,
							status,
							price: action.price,
							stock: action.stock,
							weight_g: action.weight_g,
							images: action.images ?? [],
							v_value: addedColor?.name_en ?? null,
							color_id: addedColor?.id ?? null,
							color_family: addedColor?.family ?? null,
							promo_percent: null,
							promo_ends_at: null,
							createdAt: now,
							updatedAt: now
						}
					})
				} else if (action.type === 'archive_all') {
					const live = snapshot.variants.filter(row =>
						['draft', 'active'].includes(row.status as string)
					)
					if (!live.length) throw new TypedProductError('VARIANT_STATUS_CONFLICT')
					for (const row of live) {
						const entry = patches.find(
							item =>
								item.collection === 'product_variants' &&
								item.id === String(row._id)
						)!
						Object.assign(
							entry.fields,
							patch('product_variants', row, { status: 'archived' }).fields
						)
					}
				} else if (action.type === 'delete') {
					const target = byId.get(action.id)
					if (!target) throw new TypedProductError('VARIANT_SET_CHANGED')
					if (!['draft', 'archived'].includes(target.status as string))
						throw new TypedProductError('VARIANT_DELETE_REQUIRES_INACTIVE')
					if (byId.size === 1) throw new TypedProductError('PRODUCT_NEEDS_A_VARIANT')
					await assertNeverSold(this.db, 'variant', target._id)
					// The SKU leaves: no field patch for it, only its exact before-image.
					const index = patches.findIndex(
						item => item.collection === 'product_variants' && item.id === action.id
					)
					patches.splice(index, 1, {
						collection: 'product_variants',
						id: action.id,
						fields: {},
						deletion: target
					})
				} else {
					const target = byId.get(action.id)
					if (!target) throw new TypedProductError('VARIANT_SET_CHANGED')
					// archive: draft|active → archived; restore: archived → the category's state;
					// status: any change the old admin's «Статус» select allowed.
					const status =
						action.type === 'archive'
							? 'archived'
							: action.type === 'restore'
								? snapshot.published
									? 'active'
									: 'draft'
								: action.status
					const allowedFrom =
						action.type === 'archive'
							? ['draft', 'active']
							: action.type === 'restore'
								? ['archived']
								: ['draft', 'active', 'archived']
					if (
						!allowedFrom.includes(target.status as string) ||
						target.status === status ||
						(status === 'active' && !snapshot.published)
					)
						throw new TypedProductError('VARIANT_STATUS_CONFLICT')
					if (status === 'active') {
						// With the values this same save writes, when it carries them.
						const sent = command.details?.variants.find(row => row.id === action.id)
						activate({
							id: action.id,
							price: (sent ?? target).price as unknown,
							stock: (sent ?? target).stock as unknown,
							images: (sent ?? target).images as unknown,
							weight_g: (sent ?? target).weight_g as unknown
						})
					}
					const entry = patches.find(
						row => row.collection === 'product_variants' && row.id === action.id
					)!
					Object.assign(
						entry.fields,
						patch('product_variants', target, { status }).fields
					)
				}
			}
			await this.journal.prepare(token, patches)
			started = true
			await this.journal.execute(token, 'apply')
			await this.snapshot(id)
			const inspection = await this.journal.inspect(request.operationId)
			if (inspection.counts.after + inspection.counts.both !== patches.length)
				throw Error('PRODUCT_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			return receipt(token.revision + 1)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}
}
