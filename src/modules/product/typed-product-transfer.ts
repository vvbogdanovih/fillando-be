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
import type {
	AttributeDefinition,
	AttributeEntry,
	AttributeValue
} from '../category/attribute-definitions'
import { readCategoryConfiguration } from '../category/category-configuration'
import { TypedProductError, validateTypedProduct } from './typed-product'
import { loadAxisColors } from './typed-product-colors'

/**
 * Moving a typed product to another v2 product category (Plan-0010 F04, TD-0013 «зміна
 * category_id товару»). The target's definitions decide what survives: a characteristic is carried
 * over by its key, or — a copied category gets new keys — by the same label and a compatible type;
 * everything else is listed as lost and must be confirmed. The product and its SKUs change category
 * in one journal plan; URLs, SKU codes, IDs, prices and stock never change.
 */

const normalise = (label: string) =>
	label.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()

/** The value in the target's terms, or null when it cannot be expressed without guessing. */
export function convertValue(
	source: AttributeDefinition,
	target: AttributeDefinition,
	value: AttributeValue
): AttributeValue | null {
	if (
		source.unit !== target.unit &&
		target.value_type !== 'enum' &&
		target.value_type !== 'boolean'
	)
		return null
	const label =
		source.value_type === 'enum'
			? (source.options.find(option => option.id === value)?.label ?? null)
			: null
	switch (target.value_type) {
		case 'boolean':
			return source.value_type === 'boolean' && typeof value === 'boolean' ? value : null
		case 'number':
			return source.value_type === 'number' && typeof value === 'number' ? value : null
		case 'string':
			if (source.value_type === 'string' && typeof value === 'string') return value
			return source.value_type === 'enum' ? label : null
		case 'enum': {
			if (source.value_type === 'enum') {
				const same = target.options.find(option => option.id === value)
				if (same) return same.id
			}
			const text = source.value_type === 'string' ? value : label
			if (typeof text !== 'string') return null
			return (
				target.options.find(option => normalise(option.label) === normalise(text))?.id ??
				null
			)
		}
	}
}

/** How the admin reads a stored value: enum label, Так/Ні, a number with its unit. */
function valueLabel(definition: AttributeDefinition | undefined, value: AttributeValue) {
	if (definition?.value_type === 'enum')
		return definition.options.find(option => option.id === value)?.label ?? String(value)
	if (typeof value === 'boolean') return value ? 'Так' : 'Ні'
	return definition?.unit ? `${value} ${definition.unit}` : String(value)
}

export interface TransferDrop {
	key: string
	label: string
	value: AttributeValue
	value_label: string
	reason: 'no_target' | 'type' | 'multiple' | 'axis'
}
export interface TransferPlan {
	attributes_v2: AttributeEntry[]
	mapped: {
		source_key: string
		target_key: string
		target_label: string
		value: AttributeValue
	}[]
	dropped: TransferDrop[]
	missing_required: string[]
	variant_axis: { key: string } | null
	variants: { id: string; variant_value: AttributeValue | null }[]
	axis_problem: null | 'AXIS_NO_TARGET' | 'AXIS_TYPE' | 'AXIS_VALUES'
}

/**
 * The target definition a source characteristic lands in: the same key, or — a copied category gets
 * new keys — the same normalised label. A free characteristic never lands in a dictionary-colour
 * definition; an axis prefers the definition of its own semantic (filament has a text «Колір» beside
 * the colour axis).
 */
export function matchDefinition(
	targetDefinitions: AttributeDefinition[],
	definition: AttributeDefinition,
	forAxis: boolean
): AttributeDefinition | undefined {
	const same = targetDefinitions.find(item => item.key === definition.key)
	if (same) return same
	const labelled = targetDefinitions.filter(
		item =>
			normalise(item.label) === normalise(definition.label) &&
			(forAxis || item.semantic !== 'color')
	)
	return (forAxis && labelled.find(item => item.semantic === definition.semantic)) || labelled[0]
}

/**
 * Deterministic proposal for a transfer; the same inputs always give the same plan, so the write
 * can tell whether the product changed since the admin saw the preview.
 */
export function planTransfer(
	source: {
		definitions: AttributeDefinition[]
		attributes_v2: AttributeEntry[]
		axisKey?: string | null
		variants: { id: string; variant_value: AttributeValue | null }[]
	},
	targetDefinitions: AttributeDefinition[]
): TransferPlan {
	const sourceBy = new Map(source.definitions.map(item => [item.key, item]))
	const find = (definition: AttributeDefinition, forAxis: boolean) =>
		matchDefinition(targetDefinitions, definition, forAxis)
	// The variant axis first: its target key cannot also hold a characteristic.
	let variant_axis: TransferPlan['variant_axis'] = null
	let variants = source.variants
	let axis_problem: TransferPlan['axis_problem'] = null
	const axisSource = source.axisKey ? sourceBy.get(source.axisKey) : undefined
	if (source.axisKey) {
		const target = axisSource && find(axisSource, true)
		if (!axisSource || !target || target.multiple) axis_problem = 'AXIS_NO_TARGET'
		else if ((axisSource.semantic === 'color') !== (target.semantic === 'color'))
			axis_problem = 'AXIS_TYPE'
		else {
			const converted = source.variants.map(row => ({
				id: row.id,
				variant_value:
					axisSource.semantic === 'color'
						? row.variant_value
						: row.variant_value === null
							? null
							: convertValue(axisSource, target, row.variant_value)
			}))
			const values = converted.map(row => row.variant_value)
			if (values.some(value => value === null) || new Set(values).size !== values.length)
				axis_problem = 'AXIS_VALUES'
			else {
				variant_axis = { key: target.key }
				variants = converted
			}
		}
	}
	const attributes_v2: AttributeEntry[] = []
	const mapped: TransferPlan['mapped'] = []
	const dropped: TransferDrop[] = []
	for (const entry of source.attributes_v2) {
		const definition = sourceBy.get(entry.k)
		const label = definition?.label ?? entry.k
		const drop = (reason: TransferDrop['reason']) =>
			dropped.push({
				key: entry.k,
				label,
				value: entry.v,
				value_label: valueLabel(definition, entry.v),
				reason
			})
		const target = definition && find(definition, false)
		if (!definition || !target) {
			drop('no_target')
			continue
		}
		if (target.key === variant_axis?.key) {
			drop('axis')
			continue
		}
		const value = convertValue(definition, target, entry.v)
		if (value === null) {
			drop('type')
			continue
		}
		const taken = attributes_v2.filter(row => row.k === target.key)
		if (taken.some(row => row.v === value)) continue
		if (taken.length && !target.multiple) {
			drop('multiple')
			continue
		}
		attributes_v2.push({ k: target.key, v: value })
		mapped.push({
			source_key: entry.k,
			target_key: target.key,
			target_label: target.label,
			value
		})
	}
	const present = new Set(attributes_v2.map(row => row.k))
	return {
		attributes_v2,
		mapped,
		dropped,
		missing_required: targetDefinitions
			.filter(
				item => item.is_required && item.key !== variant_axis?.key && !present.has(item.key)
			)
			.map(item => item.key),
		variant_axis,
		variants,
		axis_problem
	}
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/)
const scalar = z.union([z.string().min(1).max(2000), z.number(), z.boolean()])
export const typedProductTransferSchema = z.strictObject({
	target_category_id: objectId,
	attributes_v2: z.array(z.strictObject({ k: z.string().min(1).max(200), v: scalar })).max(200),
	variant_axis: z.strictObject({ key: z.string().min(1).max(200) }).nullable(),
	variants: z
		.array(z.strictObject({ id: objectId, variant_value: scalar.nullable() }))
		.min(1)
		.max(100),
	/** Source keys the admin agreed to lose — exactly the plan's `dropped` keys. */
	confirm_dropped: z.array(z.string().min(1).max(200)).max(200)
})
const requestSchema = z.strictObject({
	operationId: z.string().uuid(),
	ownerId: z.string().min(1),
	expectedRevision: z.number().int().nonnegative().safe()
})

export class TypedProductTransferWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		// Same field profile as the product editor: category_id/attributes/axis and SKU status.
		this.journal = new CatalogMutationJournal(db, this.gate, 'draft-product-details')
	}

	private async category(id: unknown) {
		const category =
			id instanceof mongo.ObjectId || (typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))
				? await this.db
						.collection('categories')
						.findOne(
							{ _id: new mongo.ObjectId(String(id)) },
							{ readPreference: 'primary' }
						)
				: null
		if (!category) throw new TypedProductError('CATEGORY_NOT_FOUND')
		const config = readCategoryConfiguration({
			...category,
			parent_id: category.parent_id == null ? null : String(category.parent_id)
		})
		if (
			config.attribute_contract_version !== 2 ||
			config.kind !== 'product' ||
			(category.status !== 'draft' && category.status !== 'active')
		)
			return { category, config, eligible: false }
		return { category, config, eligible: true }
	}

	private async load(productId: string, targetId: string) {
		const product = await this.db
			.collection('products')
			.findOne({ _id: new mongo.ObjectId(productId) }, { readPreference: 'primary' })
		if (!product) throw new TypedProductError('PRODUCT_NOT_FOUND')
		const source = await this.category(product.category_id)
		if (!source.eligible) throw new TypedProductError('CATALOG_CONTRACT_UPGRADE_REQUIRED')
		const target = await this.category(targetId)
		if (!target.eligible) throw new TypedProductError('TRANSFER_TARGET_INVALID')
		if (String(target.category._id) === String(source.category._id))
			throw new TypedProductError('TRANSFER_SAME_CATEGORY')
		const variants = await this.db
			.collection('product_variants')
			.find({ product_id: product._id }, { readPreference: 'primary' })
			.sort({ _id: 1 })
			.limit(101)
			.toArray()
		if (!variants.length || variants.length > 100)
			throw new TypedProductError('PRODUCT_VARIANT_LIMIT')
		if (
			variants.some(
				row =>
					String(row.category_id) !== String(product.category_id) ||
					!['draft', 'active', 'archived'].includes(row.status as string)
			)
		)
			throw new TypedProductError('TYPED_PRODUCT_DATA_UNAVAILABLE')
		const sourceDefinitions = source.config.attribute_definitions!
		const targetDefinitions = target.config.attribute_definitions!
		const axisKey = (product.variant_axis as { key?: string } | null | undefined)?.key ?? null
		const plan = planTransfer(
			{
				definitions: sourceDefinitions,
				attributes_v2: (product.attributes_v2 ?? []) as AttributeEntry[],
				axisKey,
				variants: variants.map(row => ({
					id: String(row._id),
					variant_value: (row.variant_value ?? null) as AttributeValue | null
				}))
			},
			targetDefinitions
		)
		return {
			product,
			variants,
			source: source.category,
			target: target.category,
			targetDefinitions,
			targetPublished: target.category.status === 'active',
			plan
		}
	}

	/** Read-only proposal for the admin; nothing is reserved. */
	async preview(productId: string, targetId: string) {
		objectId.parse(productId)
		objectId.parse(targetId)
		const stamp = await this.gate.readStamp()
		const loaded = await this.load(productId, targetId)
		await this.gate.assertReadUnchanged(stamp)
		const { plan, product, variants, source, target } = loaded
		const toDraft = loaded.targetPublished
			? 0
			: variants.filter(row => row.status === 'active').length
		return {
			revision: stamp.revision,
			product_id: productId,
			name: product.name as string,
			source: {
				id: String(source._id),
				name: source.name as string,
				status: source.status as string
			},
			target: {
				id: String(target._id),
				name: target.name as string,
				status: target.status as string,
				definitions: loaded.targetDefinitions
			},
			mapped: plan.mapped,
			dropped: plan.dropped,
			missing_required: plan.missing_required,
			axis_problem: plan.axis_problem,
			variants_to_draft: toDraft,
			proposal: {
				attributes_v2: plan.attributes_v2,
				variant_axis: plan.variant_axis,
				variants: plan.variants
			}
		}
	}

	async transfer(request: z.infer<typeof requestSchema>, productId: string, input: unknown) {
		request = requestSchema.parse(request)
		objectId.parse(productId)
		const command = typedProductTransferSchema.parse(input)
		const hash = createHash('sha256')
			.update(
				mongo.BSON.serialize({
					type: 'typed-product-transfer',
					id: productId,
					expected_revision: request.expectedRevision,
					command
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
			product_id: productId,
			category_id: command.target_category_id
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
			const loaded = await this.load(productId, command.target_category_id)
			const { plan, product, variants, target } = loaded
			if (plan.axis_problem) throw new TypedProductError('TRANSFER_AXIS_INCOMPATIBLE')
			// What the admin agreed to lose must still be what the move loses.
			const expectedDrops = [...new Set(plan.dropped.map(row => row.key))].sort()
			if (!isDeepStrictEqual([...new Set(command.confirm_dropped)].sort(), expectedDrops))
				throw new TypedProductError('TRANSFER_PLAN_CHANGED')
			const byId = new Map(variants.map(row => [String(row._id), row]))
			if (
				command.variants.length !== byId.size ||
				command.variants.some(row => !byId.has(row.id))
			)
				throw new TypedProductError('VARIANT_SET_CHANGED')
			const axis = loaded.targetDefinitions.find(
				item => item.key === command.variant_axis?.key
			)
			const colors = await loadAxisColors(
				this.db,
				axis?.semantic === 'color' ? command.variants.map(row => row.variant_value) : []
			)
			// The target's rules: a published category needs every required characteristic.
			const next = validateTypedProduct(
				loaded.targetDefinitions,
				{
					name: product.name as unknown,
					attributes_v2: command.attributes_v2,
					variant_axis: command.variant_axis,
					variants: command.variants
				},
				{
					active: loaded.targetPublished,
					labelFor: value => colors.get(String(value))?.label ?? null
				}
			)
			const change = (row: mongo.Document, fields: Record<string, unknown>) =>
				Object.fromEntries(
					Object.entries(fields)
						.filter(([key, value]) => !isDeepStrictEqual(row[key], value))
						.map(([key, value]) => [
							key,
							{
								before: Object.hasOwn(row, key)
									? { exists: true as const, value: row[key] as unknown }
									: { exists: false as const },
								after: { exists: true as const, value }
							}
						])
				)
			const patches: CatalogPatch[] = [
				{
					collection: 'products',
					id: productId,
					fields: change(product, {
						category_id: target._id,
						attributes_v2: next.attributes_v2,
						variant_axis: next.variant_axis
					})
				},
				...next.variants.map(row => {
					const variant = byId.get(row.id)!
					return {
						collection: 'product_variants' as const,
						id: row.id,
						fields: change(variant, {
							category_id: target._id,
							name: row.name,
							variant_value: row.variant_value,
							// A draft category sells nothing: its SKUs are drafts (published ones stay
							// as they were, the admin publishes drafts as usual).
							...(variant.status === 'active' && !loaded.targetPublished
								? { status: 'draft' }
								: {})
						})
					}
				})
			]
			await this.journal.prepare(token, patches)
			started = true
			await this.journal.execute(token, 'apply')
			const moved = await this.db
				.collection('product_variants')
				.countDocuments({ product_id: product._id, category_id: target._id })
			const inspection = await this.journal.inspect(request.operationId)
			if (
				moved !== variants.length ||
				inspection.counts.after + inspection.counts.both !== patches.length
			)
				throw Error('PRODUCT_TRANSFER_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			return receipt(token.revision + 1)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}
}
