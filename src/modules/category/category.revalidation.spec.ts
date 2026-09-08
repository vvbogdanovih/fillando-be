import { NotFoundException } from '@nestjs/common'
import { CategoryService } from './category.service'

/**
 * A category write is not only its own page (I-h): `required_attributes` is where the catalogue
 * sidebar's dimensions and the specification table's units come from, and the name sits in every
 * breadcrumb. Waiting out the hour leaves a filter on a dimension the category no longer has.
 */
const CATEGORY_ID = '000000000000000000000c01'

const buildService = () => {
	const category = { _id: CATEGORY_ID, name: 'Філамент', slug: 'filament' }
	const categoryRepository = {
		create: jest.fn().mockResolvedValue(category),
		update: jest.fn().mockResolvedValue(category),
		delete: jest.fn().mockResolvedValue(true)
	}
	const revalidation = { revalidate: jest.fn() }
	const service = new CategoryService(categoryRepository as never, revalidation as never)
	return { service, categoryRepository, revalidation }
}

const dto = {
	name: 'Філамент',
	slug: 'filament',
	required_attributes: [{ label: 'Тип пластику', filter_type: 'multi-select' as const }]
}

describe('every category write purges the storefront exactly once', () => {
	it.each([
		['create', (s: CategoryService) => s.create(dto as never)],
		['update', (s: CategoryService) => s.update(CATEGORY_ID, { name: 'Філаменти' })],
		['replace', (s: CategoryService) => s.replace(CATEGORY_ID, dto as never)],
		['delete', (s: CategoryService) => s.delete(CATEGORY_ID)]
	])('%s', async (_name, call) => {
		const { service, revalidation } = buildService()

		await call(service)

		expect(revalidation.revalidate).toHaveBeenCalledTimes(1)
		expect(revalidation.revalidate).toHaveBeenCalledWith('categories', expect.any(String))
	})
})

describe('a category write that did not happen purges nothing', () => {
	it('a PATCH that matched no category', async () => {
		const { service, categoryRepository, revalidation } = buildService()
		categoryRepository.update.mockResolvedValue(null)

		await expect(service.update(CATEGORY_ID, { name: 'X' })).rejects.toBeInstanceOf(
			NotFoundException
		)
		expect(revalidation.revalidate).not.toHaveBeenCalled()
	})

	it('a delete that matched no category', async () => {
		const { service, categoryRepository, revalidation } = buildService()
		categoryRepository.delete.mockResolvedValue(false)

		await expect(service.delete(CATEGORY_ID)).rejects.toBeInstanceOf(NotFoundException)
		expect(revalidation.revalidate).not.toHaveBeenCalled()
	})
})
