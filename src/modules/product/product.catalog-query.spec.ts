import { BadRequestException } from '@nestjs/common'
import { ProductService } from './product.service'

/**
 * `getCatalog` splits the query string into "parameters the catalogue understands" and
 * "product attribute filters". Anything it fails to reserve is sent to Mongo as an
 * `attributes.k` match, which silently returns nothing — no error, just an empty catalogue.
 * `color_family` is the parameter that trips this, because colour lives on the variant rather
 * than in `product.attributes` (TD-0002 §5.2.2).
 */
const buildService = () => {
	const findCatalogItems = jest.fn().mockResolvedValue({ items: [] })
	const service = new ProductService(
		{} as never,
		{ findCatalogItems } as never,
		{} as never,
		{} as never
	)
	return { service, findCatalogItems }
}

const callWith = async (query: Record<string, string>) => {
	const { service, findCatalogItems } = buildService()
	await service.getCatalog({ category_id: 'c1', ...query })
	const calls = findCatalogItems.mock.calls as unknown[][]
	return calls[0][0] as {
		attrFilters: Record<string, string[]>
		colorFamilies: string[]
		page: number
		limit: number
		sort: string
	}
}

describe('ProductService.getCatalog — reserved parameters', () => {
	it('routes color_family to its own filter, never to the attribute filters', async () => {
		const params = await callWith({ color_family: 'black' })

		expect(params.colorFamilies).toEqual(['black'])
		expect(params.attrFilters).not.toHaveProperty('color_family')
	})

	it('treats several colours as an OR within the dimension', async () => {
		const params = await callWith({ color_family: 'black,white, red' })

		expect(params.colorFamilies).toEqual(['black', 'white', 'red'])
	})

	it('passes an empty colour selection when the parameter is absent', async () => {
		const params = await callWith({})

		expect(params.colorFamilies).toEqual([])
	})

	it.each(['category_id', 'page', 'limit', 'price_min', 'price_max', 'sort', 'color_family'])(
		'never mistakes %s for an attribute filter',
		async key => {
			const params = await callWith({ [key]: '1' })

			expect(params.attrFilters).not.toHaveProperty(key)
		}
	)

	it('still forwards genuine attribute filters', async () => {
		const params = await callWith({ polymer: 'PLA,PETG', finish: 'Silk' })

		expect(params.attrFilters).toEqual({ polymer: ['PLA', 'PETG'], finish: ['Silk'] })
	})

	it('drops blank values rather than matching on an empty string', async () => {
		const params = await callWith({ polymer: 'PLA,,  ,PETG', color_family: 'black,,' })

		expect(params.attrFilters.polymer).toEqual(['PLA', 'PETG'])
		expect(params.colorFamilies).toEqual(['black'])
	})

	it('requires a category', async () => {
		const { service } = buildService()

		await expect(service.getCatalog({})).rejects.toBeInstanceOf(BadRequestException)
	})

	it('clamps pagination to sane bounds', async () => {
		const params = await callWith({ page: '0', limit: '5000' })

		expect(params.page).toBe(1)
		expect(params.limit).toBe(100)
	})
})
