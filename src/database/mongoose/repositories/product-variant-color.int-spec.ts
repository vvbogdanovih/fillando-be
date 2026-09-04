import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Color, ColorSchema } from '../schemas/color.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * The colour join is new aggregation code (TD-0002 §5.2.2, Plan-0004 PR-1 task 12) and is easy
 * to get subtly wrong: a `$lookup` without `preserveNullAndEmptyArrays` silently drops every
 * variant that has no dictionary colour, and a bare `$color.name_uk` path omits the key
 * instead of emitting null. Both mistakes pass a unit test and only show up against a real
 * database, so they are checked here.
 */
const PRODUCT_NAME = 'PLA Filament Colour Test'

type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository — colour join (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const categoryId = new Types.ObjectId()
	const productId = new Types.ObjectId()
	const redId = new Types.ObjectId()
	const blackId = new Types.ObjectId()
	const colouredVariantId = new Types.ObjectId()
	const colourlessVariantId = new Types.ObjectId()

	beforeAll(async () => {
		conn = await connectTestDb('product-variant-colour')

		const categoryModel = conn.model(Category.name, CategorySchema)
		const productModel = conn.model(Product.name, ProductSchema)
		const variantModel = conn.model(ProductVariant.name, ProductVariantSchema)
		const colorModel = conn.model(Color.name, ColorSchema)

		await categoryModel.create({
			_id: categoryId,
			name: 'Філамент',
			slug: 'filament',
			required_attributes: []
		})

		await colorModel.create([
			{
				_id: redId,
				name_en: 'Red',
				name_uk: 'Червоний',
				slug: 'red',
				family: ColorFamily.RED,
				hex_stops: ['#e53e3e'],
				order: 1
			},
			{
				_id: blackId,
				name_en: 'Black',
				name_uk: 'Чорний',
				slug: 'black',
				family: ColorFamily.BLACK,
				hex_stops: ['#111111'],
				order: 0
			}
		])

		await productModel.create({
			_id: productId,
			name: PRODUCT_NAME,
			category_id: categoryId,
			vendor_id: new Types.ObjectId(),
			variant_type: { key: 'color', label: 'Колір' },
			attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }]
		})

		await variantModel.create([
			{
				_id: colouredVariantId,
				product_id: productId,
				category_id: categoryId,
				name: `${PRODUCT_NAME} — Red`,
				slug: 'coloured-slug',
				sku: 'FL-000101',
				price: 649,
				stock: 5,
				images: ['https://cdn.example.invalid/red.jpg'],
				v_value: 'Red',
				status: ProductStatus.ACTIVE,
				color_id: redId,
				color_family: ColorFamily.RED
			},
			{
				_id: colourlessVariantId,
				product_id: productId,
				category_id: categoryId,
				name: `${PRODUCT_NAME} — plain`,
				slug: 'colourless-slug',
				sku: 'FL-000102',
				price: 749,
				stock: 2,
				images: [],
				v_value: 'Plain',
				status: ProductStatus.ACTIVE
			}
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	describe('findPriceSheet', () => {
		it('returns variants with and without a dictionary colour alike', async () => {
			const { items, total } = await repo.findPriceSheet({ page: 1, limit: 50 })

			// The left join must not filter: a colourless variant is still a sellable row.
			expect(total).toBe(2)
			expect(items).toHaveLength(2)
		})

		it('emits the dictionary names for a coloured variant', async () => {
			const { items } = await repo.findPriceSheet({ page: 1, limit: 50 })
			const row = items.find((i: { slug: string }) => i.slug === 'coloured-slug')

			expect(row.color_name_uk).toBe('Червоний')
			expect(row.color_name_en).toBe('Red')
		})

		it('emits explicit nulls, not missing keys, for a colourless variant', async () => {
			const { items } = await repo.findPriceSheet({ page: 1, limit: 50 })
			const coloured = items.find((i: { slug: string }) => i.slug === 'coloured-slug')
			const plain = items.find((i: { slug: string }) => i.slug === 'colourless-slug')

			expect(plain.color_name_uk).toBeNull()
			expect(plain.color_name_en).toBeNull()
			// Same shape for every row — a consumer can rely on the keys existing.
			expect(Object.keys(plain).sort()).toEqual(Object.keys(coloured).sort())
		})
	})

	describe('findCatalogItems', () => {
		const params = {
			category_id: categoryId.toString(),
			page: 1,
			limit: 50,
			sort: 'default',
			attrFilters: {}
		}

		it('keeps colourless variants in the listing', async () => {
			const { items, pagination } = await repo.findCatalogItems(params)

			expect(pagination.total).toBe(2)
			expect(items).toHaveLength(2)
		})

		it('projects the four public colour fields', async () => {
			const { items } = await repo.findCatalogItems(params)
			const coloured = items.find((i: { slug: string }) => i.slug === 'coloured-slug')

			expect(coloured.color).toEqual({
				name_uk: 'Червоний',
				name_en: 'Red',
				family: ColorFamily.RED,
				hex_stops: ['#e53e3e']
			})
		})

		it('projects null for a variant with no dictionary colour', async () => {
			const { items } = await repo.findCatalogItems(params)
			const plain = items.find((i: { slug: string }) => i.slug === 'colourless-slug')

			expect(plain.color).toBeNull()
		})
	})

	describe('findCatalogItems — colour filter and swatch options', () => {
		const base = {
			category_id: categoryId.toString(),
			page: 1,
			limit: 50,
			sort: 'default',
			attrFilters: {}
		}

		it('narrows the listing to the selected family', async () => {
			const { items, pagination } = await repo.findCatalogItems({
				...base,
				colorFamilies: [ColorFamily.RED]
			})

			expect(pagination.total).toBe(1)
			expect(items[0].slug).toBe('coloured-slug')
		})

		it('treats several families as an OR', async () => {
			const { pagination } = await repo.findCatalogItems({
				...base,
				colorFamilies: [ColorFamily.RED, ColorFamily.BLACK]
			})

			expect(pagination.total).toBe(1)
		})

		it('returns nothing for a family no variant carries', async () => {
			const { items, pagination } = await repo.findCatalogItems({
				...base,
				colorFamilies: [ColorFamily.GOLD]
			})

			expect(pagination.total).toBe(0)
			expect(items).toHaveLength(0)
		})

		it('excludes colourless variants from a colour selection', async () => {
			const { items } = await repo.findCatalogItems({
				...base,
				colorFamilies: [ColorFamily.RED]
			})

			expect(items.map((i: { slug: string }) => i.slug)).not.toContain('colourless-slug')
		})

		it('offers one swatch per family present, with a count and a colour to paint it', async () => {
			const { color_options } = await repo.findCatalogItems(base)

			expect(color_options).toEqual([
				{ family: ColorFamily.RED, count: 1, hex_stops: ['#e53e3e'] }
			])
		})

		it('keeps every swatch visible while one is selected, so the filter can be widened', async () => {
			const { color_options } = await repo.findCatalogItems({
				...base,
				colorFamilies: [ColorFamily.GOLD]
			})

			expect(color_options).toEqual([
				{ family: ColorFamily.RED, count: 1, hex_stops: ['#e53e3e'] }
			])
		})
	})

	describe('findVariantWithProduct', () => {
		it('resolves the colour of the requested variant and of its siblings', async () => {
			const result = await repo.findVariantWithProduct('coloured-slug')

			expect(result?.variant.color).toEqual({
				name_uk: 'Червоний',
				name_en: 'Red',
				family: ColorFamily.RED,
				hex_stops: ['#e53e3e']
			})

			const sibling = result?.siblings.find(s => s.slug === 'colourless-slug')
			expect(sibling?.color).toBeNull()
			expect(result?.siblings).toHaveLength(2)
		})

		it('never exposes the raw color_id or the denormalized family', async () => {
			const result = await repo.findVariantWithProduct('coloured-slug')

			expect(result?.variant).not.toHaveProperty('color_id')
			expect(result?.variant).not.toHaveProperty('color_family')
		})
	})

	describe('color_family maintenance', () => {
		it('counts the variants a colour is used by, so a dictionary entry is not deleted under them', async () => {
			await expect(repo.countByColorId(redId.toString())).resolves.toBe(1)
			await expect(repo.countByColorId(blackId.toString())).resolves.toBe(0)
		})

		it('rewrites the denormalized family and reports how many rows moved', async () => {
			const changed = await repo.updateColorFamilyByColorId(
				redId.toString(),
				ColorFamily.PINK
			)

			expect(changed).toBe(1)
			const { items } = await repo.findCatalogItems({
				category_id: categoryId.toString(),
				page: 1,
				limit: 50,
				sort: 'default',
				attrFilters: {}
			})
			expect(items).toHaveLength(2)
		})

		it('is idempotent — a second run moves nothing', async () => {
			await expect(
				repo.updateColorFamilyByColorId(redId.toString(), ColorFamily.PINK)
			).resolves.toBe(0)
		})

		it('detects drift between a variant and the dictionary it points at', async () => {
			// The dictionary still says RED while the variants now say PINK — exactly the state a
			// failed backfill would leave behind, and the one a re-run repairs.
			await expect(repo.countColorFamilyDrift()).resolves.toBe(1)

			await repo.updateColorFamilyByColorId(redId.toString(), ColorFamily.RED)
			await expect(repo.countColorFamilyDrift()).resolves.toBe(0)
		})
	})
})
