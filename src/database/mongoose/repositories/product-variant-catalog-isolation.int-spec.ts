import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Color, ColorSchema } from '../schemas/color.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * The isolation contract of TD-0005 §5.1, made executable (its §7 / §8 p.1): attribute keys are
 * derived from labels with no category in them, so two categories can share `k: polymer` with
 * different meanings. Filtering must still never cross the category line — in the listing, in
 * the facet counts, in the price range and in the swatch options, which are four separate
 * sub-pipelines of `findCatalogItems` that each match `category_id` on their own.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository.findCatalogItems — category isolation (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const filamentId = new Types.ObjectId()
	const partsId = new Types.ObjectId()
	const filamentProductId = new Types.ObjectId()
	const partsProductId = new Types.ObjectId()
	const blackId = new Types.ObjectId()
	const redId = new Types.ObjectId()

	beforeAll(async () => {
		conn = await connectTestDb('catalog-isolation')

		const categoryModel = conn.model(Category.name, CategorySchema)
		const productModel = conn.model(Product.name, ProductSchema)
		const variantModel = conn.model(ProductVariant.name, ProductVariantSchema)
		const colorModel = conn.model(Color.name, ColorSchema)
		await Promise.all([
			categoryModel.init(),
			productModel.init(),
			variantModel.init(),
			colorModel.init()
		])

		// The same label in both categories → the same generated key `polymer`.
		const polymerFilter = {
			key: 'polymer',
			label: 'Тип пластику',
			filter_type: 'multi-select' as const,
			unit: null
		}
		await categoryModel.create([
			{
				_id: filamentId,
				name: 'Філамент',
				slug: 'filament',
				required_attributes: [polymerFilter]
			},
			{ _id: partsId, name: 'Аксесуари', slug: 'parts', required_attributes: [polymerFilter] }
		])

		await colorModel.create([
			{
				_id: blackId,
				name_en: 'Black',
				name_uk: 'Чорний',
				slug: 'black',
				family: ColorFamily.BLACK,
				hex_stops: ['#111418'],
				order: 1
			},
			{
				_id: redId,
				name_en: 'Red',
				name_uk: 'Червоний',
				slug: 'red',
				family: ColorFamily.RED,
				hex_stops: ['#e53e3e'],
				order: 2
			}
		])

		await productModel.create([
			{
				_id: filamentProductId,
				name: 'Kingroon PLA',
				category_id: filamentId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }]
			},
			{
				_id: partsProductId,
				name: 'Сопло 0.4',
				category_id: partsId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				// Same key, same value — the collision §5.3 describes.
				attributes: [{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }]
			}
		])

		const variant = (
			productId: Types.ObjectId,
			categoryId: Types.ObjectId,
			sku: string,
			price: number,
			colorId: Types.ObjectId,
			family: ColorFamily
		) => ({
			product_id: productId,
			category_id: categoryId,
			name: sku,
			slug: sku.toLowerCase(),
			sku,
			price,
			stock: 5,
			images: [],
			v_value: sku,
			status: ProductStatus.ACTIVE,
			color_id: colorId,
			color_family: family
		})

		await variantModel.create([
			variant(filamentProductId, filamentId, 'FL-301', 500, blackId, ColorFamily.BLACK),
			variant(filamentProductId, filamentId, 'FL-302', 600, blackId, ColorFamily.BLACK),
			// Other category: PLA too, red, and far outside the filament price range.
			variant(partsProductId, partsId, 'FL-303', 9000, redId, ColorFamily.RED)
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	const query = (categoryId: Types.ObjectId, extra: Record<string, unknown> = {}) =>
		repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 50,
			sort: 'default',
			attrFilters: {},
			...extra
		})

	it('a shared attribute key filters only inside the requested category', async () => {
		const filament = await query(filamentId, { attrFilters: { polymer: ['PLA'] } })
		const parts = await query(partsId, { attrFilters: { polymer: ['PLA'] } })

		const skus = (result: { items: unknown[] }) =>
			(result.items as { sku: string }[]).map(i => i.sku).sort()
		expect(skus(filament)).toEqual(['FL-301', 'FL-302'])
		expect(skus(parts)).toEqual(['FL-303'])
	})

	it('facet options, price range and swatch options are computed per category', async () => {
		const filament = await query(filamentId)

		expect(filament.pagination.total).toBe(2)
		expect(filament.price_range).toEqual({ min: 500, max: 600 })
		expect(filament.filter_options.polymer).toEqual(['PLA'])
		expect(filament.color_options.map(o => o.family)).toEqual([ColorFamily.BLACK])
	})

	it('a colour family only present in the other category matches nothing here', async () => {
		const filament = await query(filamentId, { colorFamilies: [ColorFamily.RED] })
		expect(filament.pagination.total).toBe(0)
		expect(filament.items).toHaveLength(0)
	})
})
