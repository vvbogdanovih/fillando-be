import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Color, ColorSchema } from '../schemas/color.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * Two rules of the facet payload that only a real database can vouch for: `Attribute.v` is
 * `Mixed`, so `v: ''` passes the schema and reaches the aggregation (I-4), and the swatch of a
 * colour family is picked from the dictionary rather than from whichever of the family's colours
 * the pipeline happened to see first (I-21).
 *
 * Fixture, one category with two dimensions and one colour family holding three entries:
 *
 * | variant | product  | polymer | diameter | colour              | order |
 * |---------|----------|---------|----------|---------------------|-------|
 * | V1      | P-full   | PLA     | 1.75     | Gold                | 20    |
 * | V2      | P-full   | PLA     | 1.75     | Champagne Gold      | 20    |
 * | V3      | P-blank  | PETG    | ''       | Antique Gold        | 8     |
 *
 * P-blank is what the admin saves when a required attribute is left empty.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository.findCatalogItems — facet hygiene (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const categoryId = new Types.ObjectId()
	const goldId = new Types.ObjectId()
	const champagneId = new Types.ObjectId()
	const antiqueId = new Types.ObjectId()
	const FACET_KEYS = ['polymer', 'diameter']

	beforeAll(async () => {
		conn = await connectTestDb('facet-hygiene')

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

		await categoryModel.create({
			_id: categoryId,
			name: 'Філамент',
			slug: 'filament',
			required_attributes: [
				{
					key: 'polymer',
					label: 'Тип пластику',
					filter_type: 'multi-select',
					is_required: true,
					unit: null
				},
				{
					key: 'diameter',
					label: 'Діаметр',
					filter_type: 'multi-select',
					is_required: true,
					unit: 'мм'
				}
			]
		})

		await colorModel.create([
			{
				_id: goldId,
				name_en: 'Gold',
				name_uk: 'Золотий',
				slug: 'gold',
				family: ColorFamily.GOLD,
				hex_stops: ['#d4af37'],
				order: 20
			},
			{
				_id: champagneId,
				name_en: 'Champagne Gold',
				name_uk: 'Шампань',
				slug: 'champagne-gold',
				family: ColorFamily.GOLD,
				hex_stops: ['#f6e6a8', '#c9a227'],
				order: 20
			},
			{
				_id: antiqueId,
				name_en: 'Antique Gold',
				name_uk: 'Антична позолота',
				slug: 'antique-gold',
				family: ColorFamily.GOLD,
				hex_stops: ['#8c6d1f'],
				order: 8
			}
		])

		const [fullId, blankId] = [1, 2].map(() => new Types.ObjectId())
		await productModel.create([
			{
				_id: fullId,
				name: 'P-full',
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				attributes: [
					{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
					{ k: 'diameter', l: 'Діаметр', v: '1.75' }
				]
			},
			{
				_id: blankId,
				name: 'P-blank',
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				// `Attribute.v` is Mixed, so an empty string passes `required` and is stored.
				attributes: [
					{ k: 'polymer', l: 'Тип пластику', v: 'PETG' },
					{ k: 'diameter', l: 'Діаметр', v: '' }
				]
			}
		])

		const variant = (
			productId: Types.ObjectId,
			sku: string,
			colorId: Types.ObjectId,
			price: number
		) => ({
			product_id: productId,
			category_id: categoryId,
			name: sku,
			slug: sku.toLowerCase(),
			sku,
			price,
			stock: 4,
			images: [],
			v_value: sku,
			status: ProductStatus.ACTIVE,
			color_id: colorId,
			color_family: ColorFamily.GOLD
		})
		await variantModel.create([
			variant(fullId, 'FL-301', goldId, 700),
			variant(fullId, 'FL-302', champagneId, 700),
			variant(blankId, 'FL-303', antiqueId, 900)
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	const query = () =>
		repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 50,
			sort: 'newest',
			attrFilters: {},
			facetKeys: FACET_KEYS
		})

	const counts = (values: { value: string; count: number }[]) =>
		Object.fromEntries(values.map(v => [v.value, v.count]))

	it('never offers a blank attribute value as a filter value', async () => {
		const result = await query()

		// Not «one nameless checkbox with a 1 next to it» — no entry at all.
		expect(counts(result.facets.diameter)).toEqual({ '1.75': 2 })
		expect(result.facets.diameter.map(v => v.value)).not.toContain('')
	})

	it('keeps the blank out of the deprecated filter_options as well', async () => {
		const result = await query()

		expect(result.filter_options.diameter).toEqual(['1.75'])
	})

	it('still counts the product that carries the blank in its other dimensions', async () => {
		const result = await query()

		// The variant is a normal catalogue item — only that one value of it is unusable.
		expect(result.pagination.total).toBe(3)
		expect(counts(result.facets.polymer)).toEqual({ PETG: 1, PLA: 2 })
	})

	it('paints the family from its lowest-order dictionary colour', async () => {
		const result = await query()

		expect(result.color_options).toEqual([
			{ family: ColorFamily.GOLD, count: 3, hex_stops: ['#8c6d1f'] }
		])
	})
})
