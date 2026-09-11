import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Color, ColorSchema } from '../schemas/color.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * The facet contract of TD-0008 §5.3–5.4, made executable. Each dimension is counted over the
 * current narrowing with its own filter left out, every value of the category stays in the list
 * (with 0 when nothing matches), and values are ordered numerically where they are numbers.
 *
 * Fixture, one category, five active variants and one draft:
 *
 * | variant | product | polymer | finish              | vaha | colour | price  |
 * |---------|---------|---------|---------------------|------|--------|--------|
 * | V1      | P1      | PLA     | Silk                | 1    | black  | 500    |
 * | V2      | P1      | PLA     | Silk                | 1    | red    | 600    |
 * | V3      | P2      | PLA     | Matte, Silk, Silk   | 3    | black  | 700    |
 * | V4      | P3      | PETG    | —                   | 0.5  | red    | 900    |
 * | V6      | P4      | ABS     | Wood                | 1    | —      | 1200   |
 * | V5      | P4      | ABS     | Wood                | 1    | black  | draft  |
 *
 * P2 carries `Silk` twice on purpose: the count is per variant, so V3 is one Silk, not two.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository.findCatalogItems — facets (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const categoryId = new Types.ObjectId()
	const blackId = new Types.ObjectId()
	const redId = new Types.ObjectId()
	const FACET_KEYS = ['polymer', 'finish', 'vaha']

	beforeAll(async () => {
		conn = await connectTestDb('catalog-facets')

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

		const dimension = (key: string, label: string, unit: string | null = null) => ({
			key,
			label,
			filter_type: 'multi-select' as const,
			is_required: true,
			unit
		})
		await categoryModel.create({
			_id: categoryId,
			name: 'Філамент',
			slug: 'filament',
			required_attributes: [
				dimension('polymer', 'Тип пластику'),
				dimension('finish', 'Ефект поверхні'),
				dimension('vaha', 'Вага', 'кг')
			]
		})

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

		const attr = (k: string, v: string) => ({ k, l: k, v })
		const [p1, p2, p3, p4] = [1, 2, 3, 4].map(() => new Types.ObjectId())
		await productModel.create([
			{
				_id: p1,
				name: 'P1',
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				attributes: [attr('polymer', 'PLA'), attr('finish', 'Silk'), attr('vaha', '1')]
			},
			{
				_id: p2,
				name: 'P2',
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				attributes: [
					attr('polymer', 'PLA'),
					attr('finish', 'Matte'),
					attr('finish', 'Silk'),
					attr('finish', 'Silk'),
					attr('vaha', '3')
				]
			},
			{
				_id: p3,
				name: 'P3',
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				attributes: [attr('polymer', 'PETG'), attr('vaha', '0.5')]
			},
			{
				_id: p4,
				name: 'P4',
				category_id: categoryId,
				vendor_id: new Types.ObjectId(),
				variant_type: { key: 'kolir', label: 'Колір' },
				attributes: [attr('polymer', 'ABS'), attr('finish', 'Wood'), attr('vaha', '1')]
			}
		])

		const variant = (
			productId: Types.ObjectId,
			sku: string,
			price: number,
			colour: { id: Types.ObjectId; family: ColorFamily } | null,
			status: ProductStatus = ProductStatus.ACTIVE
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
			status,
			color_id: colour?.id ?? null,
			color_family: colour?.family ?? null
		})
		const black = { id: blackId, family: ColorFamily.BLACK }
		const red = { id: redId, family: ColorFamily.RED }
		await variantModel.create([
			variant(p1, 'V1', 500, black),
			variant(p1, 'V2', 600, red),
			variant(p2, 'V3', 700, black),
			variant(p3, 'V4', 900, red),
			variant(p4, 'V5', 1100, black, ProductStatus.DRAFT),
			variant(p4, 'V6', 1200, null)
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	const query = (extra: Record<string, unknown> = {}) =>
		repo.findCatalogItems({
			category_id: categoryId.toString(),
			page: 1,
			limit: 50,
			sort: 'newest',
			attrFilters: {},
			facetKeys: FACET_KEYS,
			...extra
		})

	const counts = (values: { value: string; count: number }[]) =>
		Object.fromEntries(values.map(v => [v.value, v.count]))
	const colours = (options: { family: string; count: number }[]) =>
		Object.fromEntries(options.map(o => [o.family, o.count]))

	it('with nothing narrowed, counts every active variant once per value it carries', async () => {
		const result = await query()

		expect(result.pagination.total).toBe(5)
		expect(counts(result.facets.polymer)).toEqual({ ABS: 1, PETG: 1, PLA: 3 })
		// V3 lists Silk twice and is still one Silk; the draft V5 is not a Wood.
		expect(counts(result.facets.finish)).toEqual({ Matte: 1, Silk: 3, Wood: 1 })
		expect(colours(result.color_options)).toEqual({ black: 2, red: 2 })
	})

	it('orders values numerically where they are numbers, and keeps the key order given', async () => {
		const result = await query({ facetKeys: ['vaha', 'polymer', 'finish'] })

		expect(result.facets.vaha.map(v => v.value)).toEqual(['0.5', '1', '3'])
		expect(counts(result.facets.vaha)).toEqual({ '0.5': 1, '1': 3, '3': 1 })
		expect(Object.keys(result.facets)).toEqual(['vaha', 'polymer', 'finish'])
	})

	it('leaves a dimension’s own filter out of its counts, and applies it to the others', async () => {
		const result = await query({ attrFilters: { polymer: ['PLA'] } })

		expect(result.pagination.total).toBe(3)
		// «What if I tick PETG too» — the polymer numbers do not collapse to PLA only.
		expect(counts(result.facets.polymer)).toEqual({ ABS: 1, PETG: 1, PLA: 3 })
		// Wood has no PLA and stays in the list at zero rather than disappearing.
		expect(counts(result.facets.finish)).toEqual({ Matte: 1, Silk: 3, Wood: 0 })
		expect(counts(result.facets.vaha)).toEqual({ '0.5': 0, '1': 2, '3': 1 })
		expect(colours(result.color_options)).toEqual({ black: 2, red: 1 })
	})

	it('treats colour as a dimension too: it narrows the attributes, not itself', async () => {
		const result = await query({ colorFamilies: [ColorFamily.RED] })

		expect(result.pagination.total).toBe(2)
		expect(counts(result.facets.polymer)).toEqual({ ABS: 0, PETG: 1, PLA: 1 })
		expect(colours(result.color_options)).toEqual({ black: 2, red: 2 })
	})

	it('applies the price filter to every facet, while the slider bounds stay category-wide', async () => {
		const result = await query({ price_max: 650 })

		expect(counts(result.facets.polymer)).toEqual({ ABS: 0, PETG: 0, PLA: 2 })
		expect(colours(result.color_options)).toEqual({ black: 1, red: 1 })
		expect(result.price_range).toEqual({ min: 500, max: 1200 })
	})

	it('combines two attribute filters, each counted without itself', async () => {
		const result = await query({ attrFilters: { polymer: ['PLA'], finish: ['Wood'] } })

		expect(result.pagination.total).toBe(0)
		// polymer counted under finish=Wood only: ABS has it, PLA and PETG do not.
		expect(counts(result.facets.polymer)).toEqual({ ABS: 1, PETG: 0, PLA: 0 })
		// finish counted under polymer=PLA only.
		expect(counts(result.facets.finish)).toEqual({ Matte: 1, Silk: 3, Wood: 0 })
	})

	it('returns an empty list for a dimension no product has, and derives filter_options', async () => {
		const result = await query({ facetKeys: ['polymer', 'diametr'] })

		expect(result.facets.diametr).toEqual([])
		expect(result.filter_options).toEqual({ polymer: ['ABS', 'PETG', 'PLA'], diametr: [] })
	})

	it('paints each swatch from the family’s own colour', async () => {
		const result = await query()

		expect(result.color_options).toEqual([
			{ family: ColorFamily.BLACK, count: 2, hex_stops: ['#111418'] },
			{ family: ColorFamily.RED, count: 2, hex_stops: ['#e53e3e'] }
		])
	})
})
