import { NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ProductStatus } from 'src/common/types/enums'
import { ProductService } from './product.service'

/**
 * Every admin write that changes what a shopper reads has to purge the storefront's `products`
 * cache (I-h).
 *
 * Until now only landing writes did, so the server-rendered product page, its `Product` JSON-LD
 * and its metadata lagged up to an hour behind the admin. The worst pair is stock and status:
 * the page can advertise «в наявності» while the Merchant feed, which is built per request,
 * already says the opposite, and an archived product keeps its indexable page for the rest of
 * the hour.
 */
const PRODUCT_ID = '000000000000000000000001'
const VARIANT_ID = '000000000000000000000002'
const CATEGORY_ID = '000000000000000000000c01'

const buildService = () => {
	const product = {
		_id: new Types.ObjectId(PRODUCT_ID),
		name: 'PLA Basic',
		category_id: new Types.ObjectId(CATEGORY_ID),
		toObject: () => ({ _id: new Types.ObjectId(PRODUCT_ID), name: 'PLA Basic' })
	}
	const productRepository = {
		findById: jest.fn().mockResolvedValue(product),
		create: jest.fn().mockResolvedValue(product),
		update: jest.fn().mockResolvedValue(product),
		delete: jest.fn().mockResolvedValue(true)
	}
	const productVariantRepository = {
		create: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
		update: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(VARIANT_ID) }),
		delete: jest.fn().mockResolvedValue(true),
		findOne: jest.fn().mockResolvedValue({
			_id: new Types.ObjectId(VARIANT_ID),
			v_value: 'Black',
			color_id: null
		}),
		findByProductId: jest.fn().mockResolvedValue([]),
		findBySlugs: jest.fn().mockResolvedValue([]),
		updateCategoryByProductId: jest.fn().mockResolvedValue(undefined)
	}
	const revalidation = { revalidate: jest.fn() }
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		{ increment: jest.fn().mockResolvedValue(42) } as never,
		{ findById: jest.fn().mockResolvedValue(null) } as never,
		{ findById: jest.fn().mockResolvedValue(null) } as never,
		revalidation as never
	)
	return { service, productRepository, productVariantRepository, revalidation }
}

describe('every product write purges the storefront exactly once', () => {
	it.each([
		[
			'create',
			(s: ProductService) =>
				s.create({ name: 'PLA Basic', category_id: CATEGORY_ID, vendor_id: CATEGORY_ID })
		],
		['update', (s: ProductService) => s.update(PRODUCT_ID, { vendor_id: CATEGORY_ID })],
		['delete', (s: ProductService) => s.delete(PRODUCT_ID)],
		['addVariant', (s: ProductService) => s.addVariant(PRODUCT_ID, { price: 100 })],
		[
			// Price, stock, weight and status all arrive through this one endpoint.
			'updateVariant',
			(s: ProductService) => s.updateVariant(PRODUCT_ID, VARIANT_ID, { stock: 0 })
		],
		['deleteVariant', (s: ProductService) => s.deleteVariant(PRODUCT_ID, VARIANT_ID)],
		[
			'setVariantImages',
			(s: ProductService) => s.setVariantImages(PRODUCT_ID, VARIANT_ID, { images: ['a.jpg'] })
		]
	])('%s', async (_name, call) => {
		const { service, revalidation } = buildService()

		await call(service)

		expect(revalidation.revalidate).toHaveBeenCalledTimes(1)
		expect(revalidation.revalidate).toHaveBeenCalledWith('products', expect.any(String))
	})

	it('archiving a variant purges too — the noindex must not wait out the hour', async () => {
		const { service, revalidation } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { status: ProductStatus.ARCHIVED })

		expect(revalidation.revalidate).toHaveBeenCalledWith('products', expect.any(String))
	})
})

describe('a write that did not happen purges nothing', () => {
	it('a product that does not exist', async () => {
		const { service, productRepository, revalidation } = buildService()
		productRepository.findById.mockResolvedValue(null)

		await expect(service.update(PRODUCT_ID, { name: 'X' })).rejects.toBeInstanceOf(
			NotFoundException
		)
		expect(revalidation.revalidate).not.toHaveBeenCalled()
	})

	it('a delete that matched nothing', async () => {
		const { service, productRepository, revalidation } = buildService()
		productRepository.delete.mockResolvedValue(false)

		await expect(service.delete(PRODUCT_ID)).rejects.toBeInstanceOf(NotFoundException)
		expect(revalidation.revalidate).not.toHaveBeenCalled()
	})

	it('a variant PATCH that matched nothing', async () => {
		const { service, productVariantRepository, revalidation } = buildService()
		productVariantRepository.update.mockResolvedValue(null)

		await expect(
			service.updateVariant(PRODUCT_ID, VARIANT_ID, { stock: 3 })
		).rejects.toBeInstanceOf(NotFoundException)
		expect(revalidation.revalidate).not.toHaveBeenCalled()
	})
})
