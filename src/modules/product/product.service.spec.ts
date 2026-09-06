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
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		numbersRepository as never,
		colorRepository as never
	)
	return { service, productRepository, productVariantRepository }
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
