import { Types } from 'mongoose'
import { ProductStatus } from 'src/common/types/enums'
import {
	PRICE_SHEET_PUBLIC_PROJECTION,
	PUBLIC_VARIANT_FIELDS
} from 'src/modules/product/product-public.mappers'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * Runs the real aggregation pipelines / queries of {@link ProductVariantRepository} against
 * the disposable MongoDB from `docker-compose.test.yml` (`yarn test:db:up`, then
 * `yarn test:integration`). Unit specs prove the mappers are correct in isolation; this suite
 * proves the *database* never hands supplier identifiers or DRAFT variants to the public read
 * paths — an ARCHIVED variant is found by the product page alone (TD-0006 §5.4) — and that the
 * admin paths were not over-restricted (plan-0003, task 12).
 */

/** Every field a supplier could be identified or a margin derived from. Must never leak. */
const SUPPLIER_FIELDS = [
	'prom_id',
	'vendor_product_sku',
	'prom_base_price',
	'prom_discount_ratio',
	'prom_discount_seen_at'
] as const

/** Supplier *values* seeded below — a leak through a renamed key would still surface these. */
const SUPPLIER_VALUES = ['VEND-1', 'VEND-DRAFT', 'P-1', 'P-DRAFT', 'P-ARCHIVED'] as const

/**
 * Literal allowlist of the price-sheet row keys. Kept as a literal (not derived from the
 * projection) so that adding e.g. `prom_id` to PRICE_SHEET_PUBLIC_PROJECTION fails here.
 */
const PRICE_SHEET_PUBLIC_KEYS = [
	'id',
	'product_name',
	'slug',
	'v_value',
	'sku',
	'price',
	'stock',
	'stock_updated_at',
	'image',
	'attributes',
	'variant_type',
	'color_name_uk',
	'color_name_en'
] as const

const PRODUCT_NAME = 'PLA Filament Test Product'

type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const categoryId = new Types.ObjectId()
	const productId = new Types.ObjectId()
	const activeVariantId = new Types.ObjectId()
	const draftVariantId = new Types.ObjectId()
	const archivedVariantId = new Types.ObjectId()

	beforeAll(async () => {
		conn = await connectTestDb('product-variant-repo')

		const categoryModel = conn.model(Category.name, CategorySchema)
		const productModel = conn.model(Product.name, ProductSchema)
		const variantModel = conn.model(ProductVariant.name, ProductVariantSchema)

		// Wait for background index builds so dropDatabase() in afterAll never races them.
		await Promise.all([categoryModel.init(), productModel.init(), variantModel.init()])

		await categoryModel.create({
			_id: categoryId,
			name: 'Filaments',
			slug: 'filaments',
			required_attributes: [],
			image: null,
			order: 0
		})

		await productModel.create({
			_id: productId,
			name: PRODUCT_NAME,
			category_id: categoryId,
			vendor_id: new Types.ObjectId(),
			description: { json: { type: 'doc', content: [] }, html: '<p>Test product</p>' },
			variant_type: { key: 'color', label: 'Колір' },
			attributes: [
				{ k: 'material', l: 'Матеріал', v: 'PLA' },
				{ k: 'diameter', l: 'Діаметр', v: 1.75 },
				{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' }
			]
		})

		await variantModel.create([
			{
				_id: activeVariantId,
				product_id: productId,
				category_id: categoryId,
				name: 'PLA Red',
				slug: 'active-slug',
				sku: 'FL-ACTIVE-1',
				price: 649,
				stock: 5,
				images: ['https://cdn.example.invalid/red-1.jpg'],
				v_value: 'Red',
				vendor_product_sku: 'VEND-1',
				prom_id: 'P-1',
				prom_base_price: 499,
				prom_discount_ratio: 0.2,
				prom_discount_seen_at: new Date('2026-08-19T12:00:00Z'),
				price_updated_at: new Date('2026-08-20T08:00:00Z'),
				stock_updated_at: new Date('2026-08-21T09:30:00Z'),
				status: ProductStatus.ACTIVE,
				weight_g: 1220
			},
			{
				_id: draftVariantId,
				product_id: productId,
				category_id: categoryId,
				name: 'PLA Blue',
				slug: 'draft-slug',
				sku: 'FL-DRAFT-1',
				price: 699,
				stock: 3,
				images: [],
				v_value: 'Blue',
				vendor_product_sku: 'VEND-DRAFT',
				prom_id: 'P-DRAFT',
				status: ProductStatus.DRAFT
			},
			{
				_id: archivedVariantId,
				product_id: productId,
				category_id: categoryId,
				name: 'PLA Green',
				slug: 'archived-slug',
				sku: 'FL-ARCHIVED-1',
				price: 599,
				stock: 0,
				images: [],
				v_value: 'Green',
				prom_id: 'P-ARCHIVED',
				status: ProductStatus.ARCHIVED
			}
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		if (conn) await dropTestDb(conn)
	})

	describe('findAllSlugs / countAll (public sitemap)', () => {
		it('returns only ACTIVE slugs', async () => {
			const rows = await repo.findAllSlugs()

			expect(rows.map(r => r.slug)).toEqual(['active-slug'])
			expect(rows[0].updatedAt).toBeInstanceOf(Date)
			expect(rows[0]).not.toHaveProperty('_id')
		})

		it('counts the same ACTIVE-only set the sitemap is built from', async () => {
			await expect(repo.countAll()).resolves.toBe(1)
		})
	})

	describe('findPriceSheet (public price sheet)', () => {
		it('lists only the ACTIVE variant, shaped by the public projection', async () => {
			const { items, total } = await repo.findPriceSheet({ page: 1, limit: 50 })

			expect(total).toBe(1)
			expect(items).toHaveLength(1)

			const [row] = items
			expect(row.id).toBe(activeVariantId.toString())
			expect(row.slug).toBe('active-slug')
			expect(row.product_name).toBe(PRODUCT_NAME)
			expect(row.image).toBe('https://cdn.example.invalid/red-1.jpg')
			expect(row.variant_type).toEqual({ key: 'color', label: 'Колір' })
			expect(Object.keys(row).sort()).toEqual([...PRICE_SHEET_PUBLIC_KEYS].sort())
		})

		it('keeps the literal key allowlist in sync with PRICE_SHEET_PUBLIC_PROJECTION', () => {
			const projected = Object.keys(PRICE_SHEET_PUBLIC_PROJECTION).filter(k => k !== '_id')
			expect(projected.sort()).toEqual([...PRICE_SHEET_PUBLIC_KEYS].sort())
		})

		it.each(SUPPLIER_FIELDS)('never exposes supplier field %s', async field => {
			const { items } = await repo.findPriceSheet({ page: 1, limit: 50 })
			expect(items[0]).not.toHaveProperty(field)
		})

		it('does not carry supplier values anywhere in the payload', async () => {
			const result = await repo.findPriceSheet({ page: 1, limit: 50 })
			const json = JSON.stringify(result)
			for (const value of SUPPLIER_VALUES) expect(json).not.toContain(value)
		})

		it.each([
			['the vendor product SKU', 'VEND-1'],
			['the Prom id', 'P-1']
		])('does not match %s as a search term', async (_label, q) => {
			const { items, total } = await repo.findPriceSheet({ q, page: 1, limit: 50 })
			expect(items).toEqual([])
			expect(total).toBe(0)
		})

		it.each([
			['the product name', 'PLA Filament'],
			['the public SKU', 'FL-ACTIVE-1'],
			['a product attribute value', 'PLA']
		])('matches %s as a search term', async (_label, q) => {
			const { items, total } = await repo.findPriceSheet({ q, page: 1, limit: 50 })
			expect(total).toBe(1)
			expect(items.map(i => i.slug)).toEqual(['active-slug'])
		})

		it('does not surface a DRAFT variant even when the search targets it', async () => {
			const { items, total } = await repo.findPriceSheet({
				q: 'FL-DRAFT-1',
				page: 1,
				limit: 50
			})
			expect(items).toEqual([])
			expect(total).toBe(0)
		})
	})

	describe('findVariantWithProduct (public product page)', () => {
		it('returns the ACTIVE variant restricted to PUBLIC_VARIANT_FIELDS', async () => {
			const result = await repo.findVariantWithProduct('active-slug')

			expect(result).not.toBeNull()
			expect(Object.keys(result!.variant).sort()).toEqual([...PUBLIC_VARIANT_FIELDS].sort())
			expect(result!.variant.id).toBe(activeVariantId.toString())
			expect(result!.variant.status).toBe(ProductStatus.ACTIVE)
			expect(result!.variant.weight_g).toBe(1220)
			expect(result!.product.id).toBe(productId.toString())
			expect(result!.product.name).toBe(PRODUCT_NAME)
			expect(result!.category_slug).toBe('filaments')
			expect(result!.category_name).toBe('Filaments')
		})

		it('lists only ACTIVE siblings, shaped by the same public allowlist', async () => {
			const result = await repo.findVariantWithProduct('active-slug')
			expect(result!.siblings.map(s => s.slug)).toEqual(['active-slug'])
			expect(Object.keys(result!.siblings[0]).sort()).toEqual(
				[...PUBLIC_VARIANT_FIELDS].sort()
			)
		})

		it('carries no supplier field or value anywhere in the payload', async () => {
			const result = await repo.findVariantWithProduct('active-slug')
			const json = JSON.stringify(result)

			for (const field of SUPPLIER_FIELDS) expect(json).not.toContain(`"${field}"`)
			for (const value of SUPPLIER_VALUES) expect(json).not.toContain(value)
		})

		it('returns null for the DRAFT variant', async () => {
			await expect(repo.findVariantWithProduct('draft-slug')).resolves.toBeNull()
		})

		it('finds the ARCHIVED variant, still restricted to the public allowlist', async () => {
			const result = await repo.findVariantWithProduct('archived-slug')

			expect(result).not.toBeNull()
			expect(result!.variant.status).toBe(ProductStatus.ARCHIVED)
			expect(result!.variant.weight_g).toBeNull()
			expect(Object.keys(result!.variant).sort()).toEqual([...PUBLIC_VARIANT_FIELDS].sort())
			// Siblings stay ACTIVE-only: the archived variant is not offered as a switch target.
			expect(result!.siblings.map(s => s.slug)).toEqual(['active-slug'])

			const json = JSON.stringify(result)
			for (const field of SUPPLIER_FIELDS) expect(json).not.toContain(`"${field}"`)
			for (const value of SUPPLIER_VALUES) expect(json).not.toContain(value)
		})

		it('returns null for an unknown slug', async () => {
			await expect(repo.findVariantWithProduct('no-such-slug')).resolves.toBeNull()
		})
	})

	describe('findActiveForFeed (Google Shopping feed working set)', () => {
		it('returns only the ACTIVE variant, with product, category and weight joined in', async () => {
			const rows = await repo.findActiveForFeed()

			expect(rows.map(r => r.sku)).toEqual(['FL-ACTIVE-1'])
			const [row] = rows
			expect(row.id).toBe(activeVariantId.toString())
			expect(row.product_id).toBe(productId.toString())
			expect(row.product?.name).toBe(PRODUCT_NAME)
			expect(row.product?.description_html).toBe('<p>Test product</p>')
			expect(row.product?.attributes).toEqual(
				expect.arrayContaining([{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' }])
			)
			expect(row.category).toMatchObject({
				id: categoryId.toString(),
				name: 'Filaments',
				google_product_category: null
			})
			expect(row.color).toBeNull()
			expect(row.weight_g).toBe(1220)
			expect(row.images).toEqual(['https://cdn.example.invalid/red-1.jpg'])
		})

		it('carries no supplier field or value anywhere in the rows', async () => {
			const json = JSON.stringify(await repo.findActiveForFeed())
			for (const field of SUPPLIER_FIELDS) expect(json).not.toContain(`"${field}"`)
			for (const value of SUPPLIER_VALUES) expect(json).not.toContain(value)
		})
	})

	describe('admin paths are not over-restricted', () => {
		it('findByProductId returns every status with supplier identifiers intact', async () => {
			const docs = await repo.findByProductId(productId.toString())

			expect(docs).toHaveLength(3)
			expect(docs.map(d => d.status).sort()).toEqual(
				[ProductStatus.ACTIVE, ProductStatus.ARCHIVED, ProductStatus.DRAFT].sort()
			)

			const active = docs.find(d => d.slug === 'active-slug')
			expect(active).toMatchObject({
				prom_id: 'P-1',
				vendor_product_sku: 'VEND-1',
				prom_base_price: 499,
				prom_discount_ratio: 0.2
			})
			expect(docs.find(d => d.slug === 'draft-slug')).toMatchObject({
				prom_id: 'P-DRAFT',
				vendor_product_sku: 'VEND-DRAFT'
			})
		})

		it('findBySlug still resolves DRAFT and ARCHIVED variants', async () => {
			const draft = await repo.findBySlug('draft-slug')
			const archived = await repo.findBySlug('archived-slug')

			expect(draft?._id.toString()).toBe(draftVariantId.toString())
			expect(archived?._id.toString()).toBe(archivedVariantId.toString())
		})

		it('findAllWithPromId (Prom sync) still sees every variant that has a prom_id', async () => {
			const docs = await repo.findAllWithPromId()
			expect(docs.map(d => d.prom_id).sort()).toEqual(['P-1', 'P-ARCHIVED', 'P-DRAFT'])
		})
	})
})
