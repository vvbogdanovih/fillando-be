import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Color, ColorSchema } from '../schemas/color.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * The refill pairing (Plan-0005 C9).
 *
 * Once `split-refill-products.js` has run, a refill and its spooled version are separate
 * products with no siblings in common, so `Product.spooled_product_id` is the only thing left
 * connecting them. The lookup has to prefer the same colour — a refill in Natural quoting
 * whichever spool sorts first would be worse than quoting nothing — and it only makes sense
 * against a real database, where the colour match either finds a document or does not.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository — spooled counterpart of a refill (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const categoryId = new Types.ObjectId()
	const spooledId = new Types.ObjectId()
	const refillId = new Types.ObjectId()
	const plainId = new Types.ObjectId()
	const naturalId = new Types.ObjectId()
	const blackId = new Types.ObjectId()

	beforeAll(async () => {
		conn = await connectTestDb('refill-pairing')

		const categoryModel = conn.model(Category.name, CategorySchema)
		const colorModel = conn.model(Color.name, ColorSchema)
		const productModel = conn.model(Product.name, ProductSchema)
		const variantModel = conn.model(ProductVariant.name, ProductVariantSchema)

		await categoryModel.create({
			_id: categoryId,
			name: 'Філамент',
			slug: 'filament',
			required_attributes: []
		})

		await colorModel.create([
			{
				_id: naturalId,
				name_en: 'Natural',
				name_uk: 'Прозорий',
				slug: 'natural',
				family: ColorFamily.TRANSPARENT,
				hex_stops: ['#f5f0e6'],
				order: 0
			},
			{
				_id: blackId,
				name_en: 'Black',
				name_uk: 'Чорний',
				slug: 'black',
				family: ColorFamily.BLACK,
				hex_stops: ['#111111'],
				order: 1
			}
		])

		const product = (_id: Types.ObjectId, name: string, spooled?: Types.ObjectId) => ({
			_id,
			name,
			category_id: categoryId,
			vendor_id: new Types.ObjectId(),
			attributes: [],
			...(spooled ? { spooled_product_id: spooled } : {})
		})

		await productModel.create([
			product(spooledId, 'PETG Translucent'),
			product(refillId, 'PETG Translucent (без котушки)', spooledId),
			product(plainId, 'PLA Basic')
		])

		const variant = (
			productId: Types.ObjectId,
			slug: string,
			price: number,
			colorId: Types.ObjectId | null,
			status = ProductStatus.ACTIVE
		) => ({
			product_id: productId,
			category_id: categoryId,
			name: slug,
			slug,
			sku: `FL-${slug}`,
			price,
			stock: 4,
			images: [],
			v_value: slug,
			status,
			...(colorId ? { color_id: colorId } : {})
		})

		await variantModel.create([
			// The spooled product: black is cheaper, so a colour-blind lookup would pick it.
			variant(spooledId, 'petg-black', 549, blackId),
			variant(spooledId, 'petg-natural', 579, naturalId),
			variant(spooledId, 'petg-archived', 199, naturalId, ProductStatus.ARCHIVED),
			// The refills.
			variant(refillId, 'petg-refill-natural', 489, naturalId),
			variant(refillId, 'petg-refill-nocolour', 479, null),
			// An ordinary product, paired with nothing.
			variant(plainId, 'pla-black', 399, blackId)
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	it('quotes the spooled variant of the same colour, not the cheapest one', async () => {
		const result = await repo.findVariantWithProduct('petg-refill-natural')

		expect(result?.spooled_counterpart).toEqual({
			slug: 'petg-natural',
			name: 'petg-natural',
			price: 579,
			matched_colour: true
		})
	})

	it('falls back to the cheapest active variant when the refill carries no colour', async () => {
		const result = await repo.findVariantWithProduct('petg-refill-nocolour')

		expect(result?.spooled_counterpart?.slug).toBe('petg-black')
	})

	/** The page words an unmatched figure as "from", so it has to know which branch answered. */
	it('says whether the counterpart is the same colour', async () => {
		const matched = await repo.findVariantWithProduct('petg-refill-natural')
		const fallback = await repo.findVariantWithProduct('petg-refill-nocolour')

		expect(matched?.spooled_counterpart?.matched_colour).toBe(true)
		expect(fallback?.spooled_counterpart?.matched_colour).toBe(false)
	})

	it('never quotes a non-active variant, however cheap', async () => {
		const result = await repo.findVariantWithProduct('petg-refill-nocolour')

		expect(result?.spooled_counterpart?.price).not.toBe(199)
	})

	it('is null for an ordinary product, which is paired with nothing', async () => {
		const result = await repo.findVariantWithProduct('pla-black')

		expect(result?.spooled_counterpart).toBeNull()
	})
})
