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
		update: jest.fn().mockResolvedValue(null),
		delete: jest.fn().mockResolvedValue(null)
	}
	const numbersRepository = { increment: jest.fn() }
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		numbersRepository as never
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
