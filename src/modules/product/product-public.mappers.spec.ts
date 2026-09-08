import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'
import {
	PRICE_SHEET_PUBLIC_PROJECTION,
	PUBLIC_VARIANT_FIELDS,
	toPublicAttributes,
	toPublicVariant
} from './product-public.mappers'

/** Every field a supplier could be identified or a margin derived from. Must never leak. */
const SUPPLIER_FIELDS = [
	'prom_id',
	'vendor_product_sku',
	'prom_base_price',
	'prom_discount_ratio',
	'prom_discount_seen_at'
] as const

/** Internal/document plumbing that has no business in a public payload either. */
const INTERNAL_FIELDS = [
	'_id',
	'product_id',
	'category_id',
	'createdAt',
	'updatedAt',
	'__v',
	// The raw pointer and its denormalized copy stay internal: the public payload carries the
	// resolved `color` object instead.
	'color_id',
	'color_family'
] as const

type LeanVariantDoc = ProductVariant & {
	_id: Types.ObjectId
	createdAt: Date
	updatedAt: Date
	__v: number
}

/** A lean document with EVERY schema field (plus timestamps and __v) populated. */
const fixture: LeanVariantDoc = {
	_id: new Types.ObjectId('000000000000000000000002'),
	product_id: new Types.ObjectId('000000000000000000000001'),
	category_id: new Types.ObjectId('000000000000000000000003'),
	name: 'PLA Filament — Red',
	slug: 'pla-filament-red',
	sku: 'FL-000042',
	price: 649,
	stock: 7,
	images: ['https://cdn.example.invalid/red-1.jpg', 'https://cdn.example.invalid/red-2.jpg'],
	v_value: 'Red',
	vendor_product_sku: 'VENDOR-SKU-XYZ',
	prom_id: '1234567890',
	prom_base_price: 499,
	prom_discount_ratio: 0.23,
	prom_discount_seen_at: new Date('2026-08-19T12:00:00Z'),
	price_updated_at: new Date('2026-08-20T08:00:00Z'),
	stock_updated_at: new Date('2026-08-21T09:30:00Z'),
	status: ProductStatus.ACTIVE,
	color_id: new Types.ObjectId('000000000000000000000004'),
	color_family: ColorFamily.RED,
	weight_g: 1220,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-08-21T09:30:00Z'),
	__v: 3
}

describe('toPublicVariant', () => {
	it('emits exactly the PUBLIC_VARIANT_FIELDS allowlist and nothing else', () => {
		const result = toPublicVariant(fixture)
		expect(Object.keys(result).sort()).toEqual([...PUBLIC_VARIANT_FIELDS].sort())
	})

	it.each(SUPPLIER_FIELDS)('never exposes supplier field %s', field => {
		expect(toPublicVariant(fixture)).not.toHaveProperty(field)
	})

	it.each(INTERNAL_FIELDS)('never exposes internal field %s', field => {
		expect(toPublicVariant(fixture)).not.toHaveProperty(field)
	})

	it('copies the allowed values verbatim and stringifies the id', () => {
		expect(toPublicVariant(fixture)).toEqual({
			id: '000000000000000000000002',
			name: 'PLA Filament — Red',
			slug: 'pla-filament-red',
			sku: 'FL-000042',
			price: 649,
			price_updated_at: new Date('2026-08-20T08:00:00Z'),
			stock: 7,
			images: [
				'https://cdn.example.invalid/red-1.jpg',
				'https://cdn.example.invalid/red-2.jpg'
			],
			v_value: 'Red',
			status: ProductStatus.ACTIVE,
			color: null,
			weight_g: 1220
		})
	})

	it('resolves the dictionary colour into the four public fields', () => {
		const result = toPublicVariant(fixture, {
			name_uk: 'Червоний',
			name_en: 'Red',
			family: ColorFamily.RED,
			hex_stops: ['#e53e3e']
		})

		expect(result.color).toEqual({
			name_uk: 'Червоний',
			name_en: 'Red',
			family: ColorFamily.RED,
			hex_stops: ['#e53e3e']
		})
	})

	it('emits color: null when the variant has no dictionary entry', () => {
		expect(toPublicVariant(fixture).color).toBeNull()
		expect(toPublicVariant(fixture, null).color).toBeNull()
	})

	it('normalises missing optional fields instead of dropping the keys', () => {
		const sparse = {
			...fixture,
			price_updated_at: undefined,
			images: undefined,
			v_value: undefined,
			weight_g: undefined
		} as unknown as LeanVariantDoc

		const result = toPublicVariant(sparse)
		expect(result.price_updated_at).toBeNull()
		expect(result.images).toEqual([])
		expect(result.v_value).toBeNull()
		expect(result.weight_g).toBeNull()
		expect(Object.keys(result).sort()).toEqual([...PUBLIC_VARIANT_FIELDS].sort())
	})

	it('does not spread the source: unknown extra fields on the document are dropped', () => {
		const withExtra = { ...fixture, secret_margin: 150 } as unknown as LeanVariantDoc
		expect(toPublicVariant(withExtra)).not.toHaveProperty('secret_margin')
	})
})

/**
 * The unit is the category's, matched to the attribute by key: without it the specification
 * table printed «Вага | 1» and the shopper could not tell a kilogram from a spool (I-27).
 */
describe('toPublicAttributes', () => {
	const CATEGORY_ATTRS = [
		{ key: 'vaha', unit: 'кг' },
		{ key: 'diametr', unit: 'мм' },
		{ key: 'polymer', unit: null }
	]

	const ATTRIBUTES = [
		{ k: 'vaha', l: 'Вага', v: 1 },
		{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
		{ k: 'seriia', l: 'Серія', v: 'Silk' }
	]

	it('joins the unit the category defines for the attribute key', () => {
		const rows = toPublicAttributes(ATTRIBUTES, CATEGORY_ATTRS)

		expect(rows[0]).toEqual({ k: 'vaha', l: 'Вага', v: 1, unit: 'кг' })
	})

	it('emits unit: null when the category entry carries no unit', () => {
		const rows = toPublicAttributes(ATTRIBUTES, CATEGORY_ATTRS)

		expect(rows[1]).toEqual({ k: 'polymer', l: 'Тип пластику', v: 'PLA', unit: null })
	})

	it('emits unit: null for an attribute the category says nothing about', () => {
		const rows = toPublicAttributes(ATTRIBUTES, CATEGORY_ATTRS)

		expect(rows[2]).toEqual({ k: 'seriia', l: 'Серія', v: 'Silk', unit: null })
	})

	it('keeps the key on every row so the row shape never varies', () => {
		for (const row of toPublicAttributes(ATTRIBUTES, CATEGORY_ATTRS)) {
			expect(Object.keys(row).sort()).toEqual(['k', 'l', 'unit', 'v'])
		}
	})

	it('treats a blank unit as no unit rather than printing a stray space', () => {
		const rows = toPublicAttributes(
			[{ k: 'vaha', l: 'Вага', v: 1 }],
			[{ key: 'vaha', unit: '  ' }]
		)

		expect(rows[0].unit).toBeNull()
	})

	it('does not spread the source: unknown extra fields on an attribute are dropped', () => {
		const rows = toPublicAttributes(
			[{ k: 'vaha', l: 'Вага', v: 1, vendor_product_sku: 'SKU-1' }] as never,
			CATEGORY_ATTRS
		)

		expect(rows[0]).not.toHaveProperty('vendor_product_sku')
	})

	it('answers with an empty list for a product with no attributes', () => {
		expect(toPublicAttributes([], CATEGORY_ATTRS)).toEqual([])
		expect(toPublicAttributes(undefined, CATEGORY_ATTRS)).toEqual([])
	})

	it('still maps the attributes when the category is unknown — just without units', () => {
		expect(toPublicAttributes(ATTRIBUTES)).toEqual([
			{ k: 'vaha', l: 'Вага', v: 1, unit: null },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA', unit: null },
			{ k: 'seriia', l: 'Серія', v: 'Silk', unit: null }
		])
	})
})

describe('PRICE_SHEET_PUBLIC_PROJECTION', () => {
	it('projects a fixed, reviewed set of keys (update the snapshot only after a security review)', () => {
		expect(Object.keys(PRICE_SHEET_PUBLIC_PROJECTION).sort()).toMatchInlineSnapshot(`
[
  "_id",
  "attributes",
  "color_name_en",
  "color_name_uk",
  "id",
  "image",
  "price",
  "product_name",
  "sku",
  "slug",
  "stock",
  "stock_updated_at",
  "v_value",
  "variant_type",
]
`)
	})

	it.each(SUPPLIER_FIELDS)('does not project supplier field %s', field => {
		expect(PRICE_SHEET_PUBLIC_PROJECTION).not.toHaveProperty(field)
	})

	it('suppresses the raw _id and exposes it only as a string id', () => {
		expect(PRICE_SHEET_PUBLIC_PROJECTION._id).toBe(0)
		expect(PRICE_SHEET_PUBLIC_PROJECTION.id).toEqual({ $toString: '$_id' })
	})
})

describe('PRICE_SHEET_PUBLIC_PROJECTION (exact shape)', () => {
	it('is exactly the documented public projection — keys and expressions', () => {
		// Pins the $-expressions too, so the Docker-gated int-spec is not the only guard.
		expect(PRICE_SHEET_PUBLIC_PROJECTION).toEqual({
			_id: 0,
			id: { $toString: '$_id' },
			product_name: '$product.name',
			slug: 1,
			v_value: 1,
			sku: 1,
			price: 1,
			stock: 1,
			stock_updated_at: 1,
			image: { $ifNull: [{ $arrayElemAt: ['$images', 0] }, null] },
			attributes: '$product.attributes',
			variant_type: '$product.variant_type',
			color_name_uk: { $ifNull: ['$color.name_uk', null] },
			color_name_en: { $ifNull: ['$color.name_en', null] }
		})
	})
})
