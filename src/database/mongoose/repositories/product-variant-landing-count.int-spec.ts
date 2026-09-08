import { Types } from 'mongoose'
import { ColorFamily, ProductStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Category, CategorySchema } from '../schemas/category.schema'
import { Product, ProductSchema } from '../schemas/product.schema'
import { ProductVariant, ProductVariantSchema } from '../schemas/product-variant.schema'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * The «Товарів» column and the guard that refuses to publish an empty landing (Plan-0005 D3/D6)
 * both come from one `$facet` with a branch per landing. That is exactly the shape a unit test
 * cannot vouch for: the branch names are generated, each branch re-reads the same piped input,
 * and the attribute match has to AND across keys while OR-ing within one. All of it only shows
 * up against a real database.
 *
 * A landing may also pin `color_family`, which is denormalized onto the variant instead of
 * living in `product.attributes` — the fixture therefore carries a colour on each variant, so
 * the count can be checked against the same rule the storefront filters by (I-g).
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('ProductVariantRepository.countVariantsForLandings (MongoDB integration)', () => {
	let conn: Conn
	let repo: ProductVariantRepository

	const categoryId = new Types.ObjectId()
	const otherCategoryId = new Types.ObjectId()
	const plaSilkId = new Types.ObjectId()
	const plaMatteId = new Types.ObjectId()
	const petgId = new Types.ObjectId()
	const otherCategoryProductId = new Types.ObjectId()

	const landing = (id: string, filters: Record<string, string[]>, category = categoryId) => ({
		id,
		category_id: category,
		filters
	})

	beforeAll(async () => {
		conn = await connectTestDb('landing-product-count')

		const categoryModel = conn.model(Category.name, CategorySchema)
		const productModel = conn.model(Product.name, ProductSchema)
		const variantModel = conn.model(ProductVariant.name, ProductVariantSchema)

		await categoryModel.create([
			{ _id: categoryId, name: 'Філамент', slug: 'filament', required_attributes: [] },
			{ _id: otherCategoryId, name: 'Аксесуари', slug: 'parts', required_attributes: [] }
		])

		const product = (
			_id: Types.ObjectId,
			name: string,
			attributes: { k: string; l: string; v: string }[],
			category = categoryId
		) => ({
			_id,
			name,
			category_id: category,
			vendor_id: new Types.ObjectId(),
			variant_type: { key: 'color', label: 'Колір' },
			attributes
		})

		await productModel.create([
			product(plaSilkId, 'PLA Silk', [
				{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
				{ k: 'finish', l: 'Ефект поверхні', v: 'Silk' }
			]),
			product(plaMatteId, 'PLA Matte', [
				{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
				{ k: 'finish', l: 'Ефект поверхні', v: 'Matte' }
			]),
			product(petgId, 'PETG', [{ k: 'polymer', l: 'Тип пластику', v: 'PETG' }]),
			product(
				otherCategoryProductId,
				'Сопло',
				[{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }],
				otherCategoryId
			)
		])

		const variant = (
			productId: Types.ObjectId,
			sku: string,
			status = ProductStatus.ACTIVE,
			category = categoryId
		) => ({
			product_id: productId,
			category_id: category,
			name: sku,
			slug: sku.toLowerCase(),
			sku,
			price: 649,
			stock: 5,
			images: [],
			v_value: sku,
			status
		})

		await variantModel.create([
			// PLA + Silk: two active variants, plus one draft that must not be counted.
			{ ...variant(plaSilkId, 'FL-201'), color_family: ColorFamily.RED },
			{ ...variant(plaSilkId, 'FL-202'), color_family: ColorFamily.BLACK },
			{
				...variant(plaSilkId, 'FL-203', ProductStatus.DRAFT),
				color_family: ColorFamily.RED
			},
			// PLA + Matte: one.
			{ ...variant(plaMatteId, 'FL-204'), color_family: ColorFamily.RED },
			// PETG: one, with no colour at all.
			variant(petgId, 'FL-205'),
			// Same PLA attribute, different category — must not leak into the count.
			{
				...variant(otherCategoryProductId, 'FL-206', ProductStatus.ACTIVE, otherCategoryId),
				color_family: ColorFamily.RED
			}
		])

		repo = new ProductVariantRepository(variantModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	it('counts the active variants a single pinned attribute matches', async () => {
		const counts = await repo.countVariantsForLandings([landing('pla', { polymer: ['PLA'] })])

		// FL-201, FL-202, FL-204 — the draft FL-203 and the other category's FL-206 are out.
		expect(counts.get('pla')).toBe(3)
	})

	it('ANDs across keys and ORs within one', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('pla-silk', { polymer: ['PLA'], finish: ['Silk'] }),
			landing('any-finish', { finish: ['Silk', 'Matte'] })
		])

		expect(counts.get('pla-silk')).toBe(2)
		expect(counts.get('any-finish')).toBe(3)
	})

	it('answers 0 for filters nothing matches, rather than dropping the landing', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('nope', { polymer: ['ASA'] }),
			landing('pla', { polymer: ['PLA'] })
		])

		expect(counts.get('nope')).toBe(0)
		expect(counts.has('nope')).toBe(true)
		expect(counts.get('pla')).toBe(3)
	})

	it('counts the whole category when no filter is pinned', async () => {
		const counts = await repo.countVariantsForLandings([landing('all', {})])

		expect(counts.get('all')).toBe(4)
	})

	it('never counts another category, even on the same attribute', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('other', { polymer: ['PLA'] }, otherCategoryId)
		])

		expect(counts.get('other')).toBe(1)
	})

	it('keeps each landing in its own branch when several are asked at once', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('a', { polymer: ['PLA'] }),
			landing('b', { polymer: ['PETG'] }),
			landing('c', { finish: ['Silk'] }),
			landing('d', { polymer: ['ASA'] })
		])

		expect([...counts.entries()]).toEqual([
			['a', 3],
			['b', 1],
			['c', 2],
			['d', 0]
		])
	})

	it('counts a pinned colour on the variant, the way the storefront filters by it', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('red', { color_family: ['red'] })
		])

		// FL-201 and FL-204 — the draft FL-203 and the other category's FL-206 are out, and a
		// colourless FL-205 is not a red one.
		expect(counts.get('red')).toBe(2)
	})

	it('ORs the colours of one landing and ANDs them with its attributes', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('red-or-black', { color_family: ['red', 'black'] }),
			landing('red-silk', { finish: ['Silk'], color_family: ['red'] })
		])

		expect(counts.get('red-or-black')).toBe(3)
		expect(counts.get('red-silk')).toBe(1)
	})

	it('answers 0 for a colour no variant of the category carries', async () => {
		const counts = await repo.countVariantsForLandings([
			landing('gold', { color_family: ['gold'] })
		])

		expect(counts.get('gold')).toBe(0)
	})

	it('is a no-op with no landings, without touching the database', async () => {
		await expect(repo.countVariantsForLandings([])).resolves.toEqual(new Map())
	})
})
