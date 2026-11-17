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
import { sanitizeRichText } from 'src/common/utils/html.utils'
import { ProductIdentityAllocator } from './product-identity-allocator'
import { readCategoryConfiguration } from '../category/category-configuration'
import {
	assertReady,
	supplierIdValue,
	typedProductCreateSchema,
	validateTypedProduct,
	TypedProductError
} from './typed-product'
import { loadAxisColors } from './typed-product-colors'

const contextSchema = z.strictObject({
	operationId: z.string().uuid(),
	ownerId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative().safe()
})
const identity = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24)
/** Creation-only coordinator; does not publish, change existing URLs or restore commerce snapshots. */
export class TypedProductCreator {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate)
	}
	private async enabled() {
		if (
			!(await this.db
				.collection<{ _id: string }>('catalog_control')
				.findOne(
					{ _id: 'catalog', admin_draft_writes_enabled: true },
					{ readPreference: 'primary' }
				))
		)
			throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
	}
	async create(request: z.infer<typeof contextSchema>, input: unknown) {
		request = contextSchema.parse(request)
		const command = typedProductCreateSchema.parse(input)
		const productId = identity(`typed-product:${request.operationId}`)
		const hash = createHash('sha256')
			.update(
				mongo.BSON.serialize({
					type: 'typed-product-create',
					expected_revision: request.expectedRevision,
					command
				})
			)
			.digest('hex')
		const receipt = (revision: number) => ({
			operation_id: request.operationId,
			revision,
			product_id: productId
		})
		await this.enabled()
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
			await this.enabled()
			const categoryId = new mongo.ObjectId(command.category_id),
				vendorId = new mongo.ObjectId(command.vendor_id)
			const category = await this.db.collection('categories').findOne({ _id: categoryId })
			if (!category) throw new TypedProductError('CATEGORY_NOT_FOUND')
			const config = readCategoryConfiguration({
				...category,
				parent_id: category.parent_id == null ? null : String(category.parent_id)
			})
			if (config.attribute_contract_version !== 2 || config.kind !== 'product')
				throw new TypedProductError('CATALOG_CONTRACT_UPGRADE_REQUIRED')
			if (category.status !== 'draft' && category.status !== 'active')
				throw new TypedProductError('PRODUCT_EDIT_REQUIRES_DRAFT')
			const published = category.status === 'active'
			if (!published && command.variants.some(row => row.status === 'active'))
				throw new TypedProductError('VARIANT_STATUS_CONFLICT')
			const definitions = config.attribute_definitions!
			const colorAxis =
				definitions.find(row => row.key === command.variant_axis?.key)?.semantic === 'color'
			const colors = await loadAxisColors(
				this.db,
				colorAxis ? command.variants.map(row => row.variant_value) : []
			)
			if (!(await this.db.collection('vendors').findOne({ _id: vendorId })))
				throw new TypedProductError('VENDOR_NOT_FOUND')
			const validated = validateTypedProduct(
				definitions,
				{
					name: command.name,
					attributes_v2: command.attributes_v2,
					variant_axis: command.variant_axis,
					variants: command.variants.map((row, index) => ({
						id: identity(`typed-variant:${request.operationId}:${index}`),
						variant_value: row.variant_value
					}))
				},
				{ labelFor: value => colors.get(String(value))?.label ?? null }
			)
			const description = command.description
				? { ...command.description, html: sanitizeRichText(command.description.html) }
				: null
			// A product that goes on sale at once must be complete: one refusal that names every gap
			// (a draft may be saved incomplete).
			const live = command.variants.flatMap((row, index) =>
				row.status === 'active'
					? [
							{
								id: validated.variants[index].id,
								status: 'active',
								price: row.price,
								stock: row.stock,
								images: row.images ?? [],
								weight_g: row.weight_g ?? null
							}
						]
					: []
			)
			if (live.length)
				assertReady({
					definitions,
					attributes: validated.attributes_v2,
					axisKey: validated.variant_axis?.key,
					description,
					variants: live
				})
			const allocator = new ProductIdentityAllocator(this.db)
			await allocator.requireIndexes()
			const skus = await allocator.reserveSkus(validated.variants.length)
			if (await this.db.collection('product_variants').findOne({ sku: { $in: skus } }))
				throw new TypedProductError('SKU_COUNTER_CONFLICT')
			const now = new Date(),
				product = {
					_id: new mongo.ObjectId(productId),
					name: validated.name,
					category_id: categoryId,
					vendor_id: vendorId,
					attributes_v2: validated.attributes_v2,
					variant_axis: validated.variant_axis,
					attributes: [],
					variant_type: null,
					...(description ? { description } : {}),
					...(command.purchase_notice
						? { purchase_notice: command.purchase_notice }
						: {}),
					createdAt: now,
					updatedAt: now
				}
			const patches: CatalogPatch[] = [
				{ collection: 'products', id: productId, fields: {}, creation: product }
			]
			const slugs = new Set<string>()
			for (const [index, row] of validated.variants.entries()) {
				// Names here contain only the base name + variant display value, never category copy.
				const slug = await allocator.allocate(row.name, skus[index], slugs)
				const color = colorAxis ? colors.get(String(row.variant_value)) : undefined
				slugs.add(slug)
				patches.push({
					collection: 'product_variants',
					id: row.id,
					fields: {},
					creation: {
						_id: new mongo.ObjectId(row.id),
						product_id: product._id,
						category_id: categoryId,
						name: row.name,
						slug,
						sku: skus[index],
						// As the old admin: the supplier's article if given, else our SKU.
						vendor_product_sku:
							supplierIdValue(command.variants[index].vendor_product_sku) ??
							skus[index],
						prom_id: supplierIdValue(command.variants[index].prom_id) ?? null,
						variant_value: row.variant_value,
						v_value: color?.name_en ?? null,
						color_id: color?.id ?? null,
						color_family: color?.family ?? null,
						// A draft unless «Активний» was chosen (owner, 2026-11-15) — checked above.
						status: command.variants[index].status ?? 'draft',
						// Uploaded by the creation form before the command; none sent — none.
						images: command.variants[index].images ?? [],
						price: command.variants[index].price,
						stock: command.variants[index].stock,
						weight_g: command.variants[index].weight_g ?? null,
						promo_percent: null,
						promo_ends_at: null,
						createdAt: now,
						updatedAt: now
					}
				})
			}
			await this.journal.prepare(token, patches)
			started = true
			await this.journal.execute(token, 'apply')
			const inspection = await this.journal.inspect(request.operationId)
			if (inspection.counts.after !== patches.length)
				throw Error('PRODUCT_CREATION_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			return receipt(token.revision + 1)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}
}
