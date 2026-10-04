import { NotFoundException } from '@nestjs/common'
import { ProductService } from './product.service'

/**
 * Malformed ObjectIds used to surface as a BSONError → 500. Every id-taking path must
 * answer 404 without touching a repository.
 */
const buildService = () => {
	const productRepository = { findById: jest.fn().mockResolvedValue(null) }
	const productVariantRepository = {
		findOne: jest.fn().mockResolvedValue(null),
		findByProductId: jest.fn().mockResolvedValue([]),
		findVariantWithProduct: jest.fn().mockResolvedValue(null),
		update: jest.fn().mockResolvedValue(null),
		delete: jest.fn().mockResolvedValue(null)
	}
	const numbersRepository = { increment: jest.fn() }
	const colorRepository = { findById: jest.fn().mockResolvedValue(null) }
	const categoryRepository = {
		findById: jest.fn().mockResolvedValue(null),
		findBySlug: jest.fn().mockResolvedValue(null)
	}
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		numbersRepository as never,
		colorRepository as never,
		categoryRepository as never,
		// A stub, never the shared singleton: a unit test must not POST to the storefront.
		{ revalidate: jest.fn() } as never
	)
	return { service, productRepository, productVariantRepository, categoryRepository }
}

const BAD_ID = 'not-an-object-id'
const GOOD_ID = '000000000000000000000001'

describe('ProductService — malformed ObjectId handling', () => {
	it.each([
		['findById', (s: ProductService) => s.findById(BAD_ID)],
		['getVariants', (s: ProductService) => s.getVariants(BAD_ID)],
		['getVariant (product id)', (s: ProductService) => s.getVariant(BAD_ID, GOOD_ID)],
		['getVariant (variant id)', (s: ProductService) => s.getVariant(GOOD_ID, BAD_ID)],
		['updateVariant', (s: ProductService) => s.updateVariant(GOOD_ID, BAD_ID, {} as never)],
		['deleteVariant', (s: ProductService) => s.deleteVariant(BAD_ID, GOOD_ID)],
		[
			'setVariantImages',
			(s: ProductService) => s.setVariantImages(GOOD_ID, BAD_ID, { images: [] } as never)
		]
	])('%s → 404 without hitting the repositories', async (_name, call) => {
		const { service, productRepository, productVariantRepository } = buildService()

		await expect(call(service)).rejects.toBeInstanceOf(NotFoundException)

		expect(productRepository.findById).not.toHaveBeenCalled()
		expect(productVariantRepository.findOne).not.toHaveBeenCalled()
		expect(productVariantRepository.findByProductId).not.toHaveBeenCalled()
		expect(productVariantRepository.update).not.toHaveBeenCalled()
		expect(productVariantRepository.delete).not.toHaveBeenCalled()
	})

	it('well-formed but unknown ids still answer 404 (repository consulted once)', async () => {
		const { service, productRepository } = buildService()

		await expect(service.getVariants(GOOD_ID)).rejects.toBeInstanceOf(NotFoundException)

		expect(productRepository.findById).toHaveBeenCalledTimes(1)
	})
})

describe('ProductService.getVariantBySlug — manufacturer', () => {
	const page = (attributes: Array<{ k: string; l: string; v: unknown }>) => ({
		variant: { id: 'v1', status: 'active' },
		product: { id: 'p1', name: 'Sunlu PLA Silk', attributes },
		siblings: [],
		category_slug: 'filament',
		category_name: 'Філамент',
		spooled_counterpart: null
	})

	it('reads the brand from the «Виробник» attribute, never from the vendor', async () => {
		const { service, productVariantRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(
			page([{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' }])
		)

		const result = await service.getVariantBySlug('sunlu-pla-silk-gold')

		expect(result.product.manufacturer).toBe('Sunlu')
		expect(result.product.name).toBe('Sunlu PLA Silk')
	})

	it('emits manufacturer: null when the attribute is absent — no shop-name fallback', async () => {
		const { service, productVariantRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(
			page([{ k: 'material', l: 'Матеріал', v: 'PLA' }])
		)

		const result = await service.getVariantBySlug('some-slug')

		expect(result.product.manufacturer).toBeNull()
	})

	it('answers 404 when the repository finds nothing (DRAFT or unknown slug)', async () => {
		const { service, productVariantRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(null)

		await expect(service.getVariantBySlug('draft-slug')).rejects.toBeInstanceOf(
			NotFoundException
		)
	})
})

/**
 * The unit of a characteristic lives on the category, not on the product, so the product page
 * can only print «Вага | 1 кг» once the category is joined in (I-27).
 */
describe('ProductService.getVariantBySlug — attribute units', () => {
	const CATEGORY = {
		required_attributes: [
			{ key: 'vaha', label: 'Вага', filter_type: 'multi-select', unit: 'кг' },
			{ key: 'polymer', label: 'Тип пластику', filter_type: 'multi-select', unit: null }
		]
	}

	const page = (
		attributes: Array<{ k: string; l: string; v: unknown }>,
		categorySlug = 'filament'
	) => ({
		variant: { id: 'v1', status: 'active' },
		product: { id: 'p1', name: 'Sunlu PLA Silk', attributes },
		siblings: [],
		category_slug: categorySlug,
		category_name: 'Філамент',
		spooled_counterpart: null
	})

	it('carries the unit the category defines for the attribute key', async () => {
		const { service, productVariantRepository, categoryRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(
			page([{ k: 'vaha', l: 'Вага', v: 1 }])
		)
		categoryRepository.findBySlug.mockResolvedValue(CATEGORY)

		const result = await service.getVariantBySlug('sunlu-pla-silk-gold')

		expect(categoryRepository.findBySlug).toHaveBeenCalledWith('filament')
		expect(result.product.attributes).toEqual([{ k: 'vaha', l: 'Вага', v: 1, unit: 'кг' }])
	})

	it('leaves unit null for an attribute the category has no entry for', async () => {
		const { service, productVariantRepository, categoryRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(
			page([
				{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
				{ k: 'seriia', l: 'Серія', v: 'Silk' }
			])
		)
		categoryRepository.findBySlug.mockResolvedValue(CATEGORY)

		const result = await service.getVariantBySlug('sunlu-pla-silk-gold')

		expect(result.product.attributes).toEqual([
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA', unit: null },
			{ k: 'seriia', l: 'Серія', v: 'Silk', unit: null }
		])
	})

	it('does not look a category up when the payload carries no category slug', async () => {
		const { service, productVariantRepository, categoryRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(
			page([{ k: 'vaha', l: 'Вага', v: 1 }], null as unknown as string)
		)

		const result = await service.getVariantBySlug('sunlu-pla-silk-gold')

		expect(categoryRepository.findBySlug).not.toHaveBeenCalled()
		expect(result.product.attributes).toEqual([{ k: 'vaha', l: 'Вага', v: 1, unit: null }])
	})

	it('adds nothing but the unit — no supplier field reaches the public attribute', async () => {
		const { service, productVariantRepository, categoryRepository } = buildService()
		productVariantRepository.findVariantWithProduct.mockResolvedValue(
			page([{ k: 'vaha', l: 'Вага', v: 1, vendor_product_sku: 'SKU-1' } as never])
		)
		categoryRepository.findBySlug.mockResolvedValue(CATEGORY)

		const result = await service.getVariantBySlug('sunlu-pla-silk-gold')

		expect(Object.keys(result.product.attributes[0]).sort()).toEqual(['k', 'l', 'unit', 'v'])
	})
})

describe('ProductService — promotions (TD-0012)', () => {
	const PRODUCT_ID = '000000000000000000000011'
	const VARIANT_ID = '000000000000000000000012'
	const product = { _id: PRODUCT_ID, name: 'PLA Basic', category_id: '000000000000000000000013' }

	const build = (existing: Record<string, unknown> | null = null) => {
		const productRepository = { findById: jest.fn().mockResolvedValue(product) }
		const variants = [
			{ _id: VARIANT_ID, price: 500, prom_base_price: 400, prom_discount_ratio: 0.1 }
		]
		const productVariantRepository = {
			findOne: jest.fn().mockResolvedValue(existing),
			findByProductId: jest.fn().mockResolvedValue(variants),
			setPromoByProductId: jest.fn().mockResolvedValue({ matched: 1, modified: 1 }),
			update: jest
				.fn<Promise<unknown>, [unknown, Record<string, unknown>]>()
				.mockImplementation((_f, patch) => Promise.resolve({ ...existing, ...patch }))
		}
		const revalidation = { revalidate: jest.fn() }
		const feedRefresh = { request: jest.fn() }
		const service = new ProductService(
			productRepository as never,
			productVariantRepository as never,
			{ increment: jest.fn() } as never,
			{ findById: jest.fn().mockResolvedValue(null) } as never,
			{ findById: jest.fn().mockResolvedValue(null) } as never,
			revalidation as never,
			feedRefresh as never
		)
		return { service, productRepository, productVariantRepository, revalidation, feedRefresh }
	}

	const variant = (over: Record<string, unknown> = {}) => ({
		_id: VARIANT_ID,
		product_id: PRODUCT_ID,
		name: 'PLA Basic',
		slug: 'pla-basic',
		v_value: null,
		color_id: null,
		price: 500,
		promo_percent: null,
		promo_ends_at: null,
		...over
	})

	describe('setProductPromotion', () => {
		it('writes the promotion to every variant, purges the storefront and asks for the feed', async () => {
			const { service, productVariantRepository, revalidation, feedRefresh } = build()
			const ends = '2099-01-01T00:00:00.000Z'

			const result = await service.setProductPromotion(PRODUCT_ID, {
				promo_percent: 15,
				promo_ends_at: ends
			})

			expect(productVariantRepository.setPromoByProductId).toHaveBeenCalledWith(PRODUCT_ID, {
				promo_percent: 15,
				promo_ends_at: new Date(ends)
			})
			expect(revalidation.revalidate).toHaveBeenCalledWith('products', 'product promotion')
			expect(feedRefresh.request).toHaveBeenCalledWith('product promotion')
			expect(result).toMatchObject({ matched: 1, modified: 1 })
			// Admin view: the stored document plus what the shop pays for it.
			expect(result.variants[0]).toMatchObject({ price: 500, supplier_price: 360 })
		})

		it('clears both fields on promo_percent: null', async () => {
			const { service, productVariantRepository } = build()
			await service.setProductPromotion(PRODUCT_ID, { promo_percent: null })
			expect(productVariantRepository.setPromoByProductId).toHaveBeenCalledWith(PRODUCT_ID, {
				promo_percent: null,
				promo_ends_at: null
			})
		})

		it('refuses an end date in the past with a coded 400 and writes nothing', async () => {
			const { service, productVariantRepository } = build()
			await expect(
				service.setProductPromotion(PRODUCT_ID, {
					promo_percent: 15,
					promo_ends_at: '2020-01-01T00:00:00.000Z'
				})
			).rejects.toMatchObject({ response: { code: 'PROMO_ENDS_IN_PAST' } })
			expect(productVariantRepository.setPromoByProductId).not.toHaveBeenCalled()
		})

		it('is a 404 for a product that does not exist', async () => {
			const { service, productRepository } = build()
			productRepository.findById.mockResolvedValue(null)
			await expect(
				service.setProductPromotion(PRODUCT_ID, { promo_percent: 10 })
			).rejects.toBeInstanceOf(NotFoundException)
		})
	})

	describe('updateVariant', () => {
		it('turns the wire date into a Date, leaves price_updated_at alone and tells the feed', async () => {
			const { service, productVariantRepository, feedRefresh } = build(variant())
			const ends = '2099-01-01T00:00:00.000Z'

			await service.updateVariant(PRODUCT_ID, VARIANT_ID, {
				promo_percent: 20,
				promo_ends_at: ends
			})

			const patch = productVariantRepository.update.mock.calls[0][1]
			expect(patch).toEqual({ promo_percent: 20, promo_ends_at: new Date(ends) })
			expect(feedRefresh.request).toHaveBeenCalledWith('variant promotion')
		})

		it('keeps the stored percent when only the date is sent', async () => {
			const { service, productVariantRepository } = build(variant({ promo_percent: 10 }))
			await service.updateVariant(PRODUCT_ID, VARIANT_ID, {
				promo_ends_at: '2099-01-01T00:00:00.000Z'
			})
			expect(productVariantRepository.update.mock.calls[0][1]).toEqual({
				promo_ends_at: new Date('2099-01-01T00:00:00.000Z')
			})
		})

		it('refuses a date on a variant with no percent to apply it to', async () => {
			const { service, productVariantRepository } = build(variant())
			await expect(
				service.updateVariant(PRODUCT_ID, VARIANT_ID, {
					promo_ends_at: '2099-01-01T00:00:00.000Z'
				})
			).rejects.toMatchObject({ response: { code: 'PROMO_PERCENT_REQUIRED' } })
			expect(productVariantRepository.update).not.toHaveBeenCalled()
		})

		it('does not bother the feed for a write that says nothing about the promo', async () => {
			const { service, feedRefresh } = build(variant())
			await service.updateVariant(PRODUCT_ID, VARIANT_ID, { stock: 3 })
			expect(feedRefresh.request).not.toHaveBeenCalled()
		})
	})

	it('getVariants adds the supplier price for the admin and nothing for a variant never priced from Prom', async () => {
		const { service, productVariantRepository } = build()
		productVariantRepository.findByProductId.mockResolvedValue([
			{ _id: 'a', price: 500, prom_base_price: 400, prom_discount_ratio: 0.1 },
			{ _id: 'b', price: 500, prom_base_price: null, prom_discount_ratio: null }
		])
		const result = await service.getVariants(PRODUCT_ID)
		expect(result.map(v => v.supplier_price)).toEqual([360, null])
	})
})
