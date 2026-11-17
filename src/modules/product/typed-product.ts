import { z } from 'zod'
import { PROMO_PERCENT_MAX, PROMO_PERCENT_MIN } from './promo-pricing'
import { productReadiness, type ReadinessIssue } from './product-readiness'
import {
	AttributeDefinition,
	validateAttributes,
	validateVariantValue
} from '../category/attribute-definitions'

const scalar = z.union([z.string().min(1).max(2000), z.number(), z.boolean()])
/**
 * Supplier identifiers, as the old admin's «Артикул вендора» / «ID на Промі»: optional, admin-only.
 * `prom_id` is the key of the Prom price/stock sync. `undefined` leaves the stored value alone;
 * an empty string or null clears it.
 */
const supplierId = z.string().trim().max(100).nullable().optional()
export const supplierIdValue = (value: string | null | undefined) =>
	value === undefined ? undefined : value?.trim() || null
/** React prints these as text, so markup and control characters are dropped, never encoded. */
const plainText = (value: string) =>
	value
		.replace(/<[^>]*>/g, '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
/**
 * The product's own notice above the buy button and the text on its photo (owner, 2026-11-05:
 * a refill warning belongs to the refill, not to a category rule). `null` — none.
 */
export const purchaseNoticeSchema = z
	.strictObject({
		title: z.string().max(1000).transform(plainText).pipe(z.string().min(1).max(120)),
		text: z.string().max(5000).transform(plainText).pipe(z.string().min(1).max(1000)),
		badge: z
			.string()
			.max(400)
			.transform(plainText)
			.pipe(z.string().max(40))
			.nullable()
			.transform(value => value || null)
	})
	.nullable()
export type PurchaseNotice = z.infer<typeof purchaseNoticeSchema>
/**
 * A SKU's photos: public http(s) addresses in display order (the first is the main one), at most
 * 30. One rule for a details save and for creation — the form uploads first, then sends these.
 */
const imagesSchema = z
	.array(
		z
			.string()
			.max(2048)
			.url()
			.refine(value => /^https?:\/\//.test(value))
	)
	.max(30)
/** The product's description as the editor writes it; `null` — none. */
const descriptionSchema = z
	.strictObject({
		html: z.string().max(100000),
		json: z
			.record(z.string(), z.unknown())
			.refine(value => JSON.stringify(value).length <= 100000)
	})
	.nullable()
/** Parcel weight in grams; `null` — unknown (a readiness warning, never an issue). */
const weightSchema = z.number().int().positive().max(1000000000).nullable()
export const productDetailsSchema = z.strictObject({
	token: z.string().regex(/^[a-f0-9]{64}$/),
	description: descriptionSchema,
	/** `undefined` keeps the stored notice; `null` removes it. */
	purchase_notice: purchaseNoticeSchema.optional(),
	variants: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-f0-9]{24}$/),
				price: z.number().nonnegative().max(1000000000),
				stock: z.number().int().nonnegative().safe(),
				weight_g: weightSchema,
				vendor_product_sku: supplierId,
				prom_id: supplierId,
				/**
				 * The SKU's promotion (TD-0012), as the old admin's variant form: `undefined`
				 * keeps it, a percent sets it, `null` clears both. An end date must be in the
				 * future and needs a percent (`resolvePromoPatch`).
				 */
				promo_percent: z
					.number()
					.int()
					.min(PROMO_PERCENT_MIN)
					.max(PROMO_PERCENT_MAX)
					.nullable()
					.optional(),
				promo_ends_at: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}T/)
					.nullable()
					.optional(),
				images: imagesSchema
			})
		)
		.min(1)
		.max(100)
})
export const variantActionSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('add'),
		variant_value: scalar,
		price: z.number().nonnegative().max(1000000000),
		stock: z.number().int().nonnegative().safe(),
		weight_g: weightSchema,
		/** A draft unless asked otherwise; active only for a complete product (`assertReady`). */
		status: z.enum(['draft', 'active']).optional(),
		vendor_product_sku: supplierId,
		prom_id: supplierId,
		/** Photos added with the SKU, uploaded beforehand; omitted — none. */
		images: imagesSchema.optional()
	}),
	z.strictObject({ type: z.literal('archive'), id: z.string().regex(/^[a-f0-9]{24}$/) }),
	/** Every draft/active SKU of the product → archived, in one plan (the old «Видалити» use). */
	z.strictObject({ type: z.literal('archive_all') }),
	/** Remove a never-sold draft/archived SKU; the product keeps at least one. */
	z.strictObject({ type: z.literal('delete'), id: z.string().regex(/^[a-f0-9]{24}$/) }),
	z.strictObject({ type: z.literal('restore'), id: z.string().regex(/^[a-f0-9]{24}$/) }),
	z.strictObject({
		type: z.literal('status'),
		id: z.string().regex(/^[a-f0-9]{24}$/),
		status: z.enum(['draft', 'active', 'archived'])
	})
])
export const typedProductEditSchema = z.strictObject({
	name: z.string().trim().min(1).max(200),
	/** The supplier (old admin's «Постачальник»); omit to keep. */
	vendor_id: z
		.string()
		.regex(/^[a-f0-9]{24}$/)
		.optional(),
	details: productDetailsSchema.optional(),
	variant_action: variantActionSchema.optional(),
	attributes_v2: z.array(z.strictObject({ k: z.string().min(1).max(100), v: scalar })).max(1000),
	variant_axis: z.strictObject({ key: z.string().min(1).max(100) }).nullable(),
	variants: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-f0-9]{24}$/),
				variant_value: scalar.nullable()
			})
		)
		.min(1)
		.max(100)
})
export type TypedProductEdit = z.infer<typeof typedProductEditSchema>
export class TypedProductError extends Error {
	constructor(readonly code: string) {
		super(code)
	}
}
/** A SKU was asked to become active while the product is incomplete; `issues` say what is missing. */
export class ProductNotReadyError extends TypedProductError {
	constructor(readonly issues: ReadinessIssue[]) {
		super('PRODUCT_NOT_READY')
	}
}
/**
 * A SKU becomes active — on sale at once — only when the product is complete (owner, 2026-11-15):
 * a description, every required characteristic, and for each SKU going active a positive price, a
 * valid stock and a photo; an unknown parcel weight stays a warning. The rule is
 * `productReadiness`, the one publication and the editor's «Готовність даних товару» use. Only
 * the transition is judged: `variants` are the SKUs that become active, as they will be stored —
 * a save of a SKU that is already active is never refused by this.
 */
export function assertReady(input: Parameters<typeof productReadiness>[0]) {
	const { issues } = productReadiness(input)
	if (issues.length) throw new ProductNotReadyError(issues)
}

export function validateTypedProduct(
	definitions: AttributeDefinition[],
	input: unknown,
	options: {
		/** A published product: every required characteristic must be present. */
		active?: boolean
		/** Display text of a stored axis value that is not its own label (dictionary colour). */
		labelFor?: (value: string | number | boolean) => string | null
	} = {}
) {
	const value = typedProductEditSchema.parse(input)
	const axisKey = value.variant_axis?.key
	const attributes = validateAttributes(definitions, value.attributes_v2, {
		active: options.active ?? false,
		axisKey
	})
	const ids = new Set<string>(),
		values = new Set<string | number | boolean>()
	if (!axisKey && value.variants.length !== 1)
		throw new TypedProductError('SINGLE_VARIANT_REQUIRED')
	const axis = definitions.find(item => item.key === axisKey)
	const variants = value.variants.map(variant => {
		if (ids.has(variant.id)) throw new TypedProductError('DUPLICATE_VARIANT_ID')
		ids.add(variant.id)
		if (!axisKey) {
			if (variant.variant_value !== null)
				throw new TypedProductError('UNEXPECTED_VARIANT_VALUE')
			return { ...variant, name: value.name }
		}
		const checked = validateVariantValue(definitions, axisKey, variant.variant_value)
		if (values.has(checked)) throw new TypedProductError('DUPLICATE_VARIANT_VALUE')
		values.add(checked)
		if (axis!.semantic === 'color') {
			// The stored value is a dictionary id; the name carries the dictionary label, exactly
			// as the legacy `variantName` writes it («… — Чорний (Black)»).
			const color = options.labelFor?.(checked)
			if (!color) throw new TypedProductError('UNKNOWN_COLOR')
			return { ...variant, name: `${value.name} — ${color}` }
		}
		const label =
			axis!.value_type === 'enum'
				? axis!.options.find(option => option.id === checked)!.label
				: typeof checked === 'boolean'
					? checked
						? 'Так'
						: 'Ні'
					: String(checked)
		const suffix = axis!.unit ? `${label} ${axis!.unit}` : label
		return { ...variant, name: `${value.name} — ${suffix}` }
	})
	return { ...value, attributes_v2: attributes, variants }
}

export const typedProductCreateSchema = typedProductEditSchema
	.omit({ variants: true, details: true, variant_action: true })
	.extend({
		category_id: z.string().regex(/^[a-f0-9]{24}$/),
		vendor_id: z.string().regex(/^[a-f0-9]{24}$/),
		/** Stored as a details save stores it (sanitised); omitted or `null` — none. */
		description: descriptionSchema.optional(),
		/** The product's own notice above the buy button; omitted or `null` — none. */
		purchase_notice: purchaseNoticeSchema.optional(),
		variants: z
			.array(
				z.strictObject({
					variant_value: scalar.nullable(),
					price: z.number().nonnegative().max(1_000_000_000),
					stock: z.number().int().nonnegative().safe(),
					weight_g: weightSchema.optional(),
					/** A draft unless asked otherwise; active only for a complete product. */
					status: z.enum(['draft', 'active']).optional(),
					vendor_product_sku: supplierId,
					prom_id: supplierId,
					/** Photos added in the creation form; omitted — none. */
					images: imagesSchema.optional()
				})
			)
			.min(1)
			.max(100)
	})
export type TypedProductCreate = z.infer<typeof typedProductCreateSchema>
