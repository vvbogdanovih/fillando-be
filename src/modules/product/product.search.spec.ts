import { Types } from 'mongoose'
import { ProductService } from './product.service'

/**
 * Storefront search after the short names (TD-0002, migration 3k): the word a shopper types most
 * — «філамент» — left the product names and lives on the category, so the search unions the
 * text hits with every product of a category whose name matches.
 */
const buildService = (opts: {
	textHits: Types.ObjectId[]
	categoryIds: Types.ObjectId[]
	categoryProducts: Types.ObjectId[]
}) => {
	const findSearchResults = jest
		.fn<Promise<unknown>, [{ productIds: Types.ObjectId[] }]>()
		.mockResolvedValue({ items: [], total: 0 })
	const productRepository = {
		findByTextSearch: jest
			.fn()
			.mockResolvedValue(opts.textHits.map(_id => ({ _id, score: 1 }))),
		findIdsByCategoryIds: jest.fn().mockResolvedValue(opts.categoryProducts)
	}
	const productVariantRepository = {
		findBySkuPrefix: jest.fn().mockResolvedValue([]),
		findSearchResults
	}
	const categoryRepository = { findIdsByNameMatch: jest.fn().mockResolvedValue(opts.categoryIds) }
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		{} as never,
		{} as never,
		categoryRepository as never,
		// A stub, never the shared singleton: a unit test must not POST to the storefront.
		{ revalidate: jest.fn() } as never
	)
	return { service, findSearchResults, productRepository, categoryRepository }
}

describe('ProductService.search — category-name fallback', () => {
	const a = new Types.ObjectId()
	const b = new Types.ObjectId()
	const c = new Types.ObjectId()
	const category = new Types.ObjectId()

	it('adds every product of a matching category after the text hits, without duplicates', async () => {
		const { service, findSearchResults, productRepository } = buildService({
			textHits: [a],
			categoryIds: [category],
			categoryProducts: [a, b, c]
		})

		await service.search({ q: 'філамент', page: 1, limit: 20 })

		expect(productRepository.findIdsByCategoryIds).toHaveBeenCalledWith([category])
		const call = findSearchResults.mock.calls[0][0]
		expect(call.productIds.map(String)).toEqual([a, b, c].map(String))
	})

	it('changes nothing for a query that names no category', async () => {
		const { service, findSearchResults, productRepository } = buildService({
			textHits: [a, b],
			categoryIds: [],
			categoryProducts: []
		})

		await service.search({ q: 'silk', page: 1, limit: 20 })

		expect(productRepository.findIdsByCategoryIds).toHaveBeenCalledWith([])
		const call = findSearchResults.mock.calls[0][0]
		expect(call.productIds.map(String)).toEqual([a, b].map(String))
	})
})
