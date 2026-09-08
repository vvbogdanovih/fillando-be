import { BadRequestException } from '@nestjs/common'
import { ProductService } from './product.service'

/**
 * `getCatalog` splits the query string into "parameters the catalogue understands" and
 * "product attribute filters". Anything it fails to reserve is sent to Mongo as an
 * `attributes.k` match, which silently returns nothing — no error, just an empty catalogue.
 * `color_family` is the parameter that trips this, because colour lives on the variant rather
 * than in `product.attributes` (TD-0002 §5.2.2).
 */
const CATEGORY_ID = '69b7c630ff27ba94157052dd'

/** The category `getCatalog` reads to learn which keys are facet dimensions (TD-0008 §5.3). */
const CATEGORY = {
	required_attributes: [
		{ key: 'polymer', label: 'Тип пластику', filter_type: 'multi-select', unit: null },
		{ key: 'finish', label: 'Ефект поверхні', filter_type: 'multi-select', unit: null }
	]
}

const buildService = (category: unknown = CATEGORY) => {
	const findCatalogItems = jest.fn().mockResolvedValue({ items: [] })
	const findById = jest.fn().mockResolvedValue(category)
	const service = new ProductService(
		{} as never,
		{ findCatalogItems } as never,
		{} as never,
		{} as never,
		{ findById } as never
	)
	return { service, findCatalogItems, findById }
}

type CatalogParams = {
	attrFilters: Record<string, string[]>
	colorFamilies: string[]
	facetKeys: string[]
	page: number
	limit: number
	price_min?: number
	price_max?: number
	sort: string
}

const firstCall = (findCatalogItems: jest.Mock) =>
	(findCatalogItems.mock.calls as unknown[][])[0][0] as CatalogParams

const callWith = async (query: Record<string, string>) => {
	const { service, findCatalogItems } = buildService()
	await service.getCatalog({ category_id: CATEGORY_ID, ...query })
	return firstCall(findCatalogItems)
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
			const params = await callWith({ [key]: key === 'category_id' ? CATEGORY_ID : '1' })

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

	it('rejects a category id that is not an ObjectId instead of failing inside Mongo', async () => {
		const { service, findCatalogItems } = buildService()

		await expect(service.getCatalog({ category_id: 'c1' })).rejects.toBeInstanceOf(
			BadRequestException
		)
		expect(findCatalogItems).not.toHaveBeenCalled()
	})

	it('clamps pagination to sane bounds', async () => {
		const params = await callWith({ page: '0', limit: '5000' })

		expect(params.page).toBe(1)
		expect(params.limit).toBe(100)
	})
})

/**
 * `parseInt('abc')` is `NaN`, and `NaN` survives `Math.min`/`Math.max` untouched — it used to
 * reach `$skip`/`$limit`, make the aggregation throw and show the shopper an error screen for a
 * URL as ordinary as `/filament?limit=abc`. Junk is a default now, never a 500 (I-10).
 */
describe('ProductService.getCatalog — junk numeric parameters', () => {
	it.each([
		['limit=abc', { limit: 'abc' }, { page: 1, limit: 20 }],
		['page=abc', { page: 'abc' }, { page: 1, limit: 20 }],
		['page=-5', { page: '-5' }, { page: 1, limit: 20 }],
		['limit=99999', { limit: '99999' }, { page: 1, limit: 100 }],
		['limit=0', { limit: '0' }, { page: 1, limit: 1 }],
		['limit= (empty)', { limit: '' }, { page: 1, limit: 20 }],
		['page=NaN', { page: 'NaN' }, { page: 1, limit: 20 }],
		['page=Infinity', { page: 'Infinity' }, { page: 1, limit: 20 }],
		['page=2.7', { page: '2.7' }, { page: 2, limit: 20 }]
	])('%s → readable pagination, never NaN', async (_name, query, expected) => {
		const params = await callWith(query)

		expect(params.page).toBe(expected.page)
		expect(params.limit).toBe(expected.limit)
		expect(Number.isNaN(params.page)).toBe(false)
		expect(Number.isNaN(params.limit)).toBe(false)
	})

	it('keeps a readable page and limit as they are', async () => {
		const params = await callWith({ page: '3', limit: '48' })

		expect(params.page).toBe(3)
		expect(params.limit).toBe(48)
	})

	it.each(['price_min', 'price_max'])(
		'drops %s entirely when it is not a number, instead of matching on NaN',
		async key => {
			const params = await callWith({ [key]: 'abc' })

			expect(params.price_min).toBeUndefined()
			expect(params.price_max).toBeUndefined()
		}
	)

	it('keeps readable price bounds', async () => {
		const params = await callWith({ price_min: '250', price_max: '999.5' })

		expect(params.price_min).toBe(250)
		expect(params.price_max).toBe(999.5)
	})

	it('still forwards the attribute filters when the numbers next to them are junk', async () => {
		const params = await callWith({ limit: 'abc', page: 'abc', polymer: 'PLA,PETG' })

		expect(params.attrFilters).toEqual({ polymer: ['PLA', 'PETG'] })
		expect(params.page).toBe(1)
		expect(params.limit).toBe(20)
	})

	it('survives a repeated parameter, which Express hands over as an array', async () => {
		const { service, findCatalogItems } = buildService()

		await service.getCatalog({
			category_id: CATEGORY_ID,
			page: ['1', '2'],
			limit: ['10', '20'],
			price_min: ['1', '2'],
			color_family: ['black', 'white'],
			polymer: ['PLA', 'PETG']
		} as unknown as Record<string, string>)

		const params = firstCall(findCatalogItems)
		expect(params.page).toBe(1)
		expect(params.limit).toBe(20)
		expect(params.price_min).toBeUndefined()
		expect(params.colorFamilies).toEqual([])
		expect(params.attrFilters).not.toHaveProperty('polymer')
	})
})

describe('ProductService.getCatalog — facet dimensions', () => {
	it('takes the facet keys from the category, in its order, never from the query', async () => {
		const { service, findCatalogItems, findById } = buildService()

		await service.getCatalog({ category_id: CATEGORY_ID, kolir: 'Чорний' })

		expect(findById).toHaveBeenCalledWith(CATEGORY_ID)
		expect(firstCall(findCatalogItems).facetKeys).toEqual(['polymer', 'finish'])
	})

	it('asks for no facets when the category does not exist, without throwing', async () => {
		const { service, findCatalogItems } = buildService(null)

		await service.getCatalog({ category_id: CATEGORY_ID })

		expect(firstCall(findCatalogItems).facetKeys).toEqual([])
	})
})
