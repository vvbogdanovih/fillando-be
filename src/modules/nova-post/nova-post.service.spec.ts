import { NovaPostWarehouseType } from 'src/common/types/enums'
import { NovaPostCityRepository } from 'src/database/mongoose/repositories/nova-post-city.repository'
import { NovaPostWarehouseRepository } from 'src/database/mongoose/repositories/nova-post-warehouse.repository'
import { NovaPostService } from './nova-post.service'

const PARCEL_LOCKER_ID = 'f9316480-5f2d-425d-bc2c-ac7cd29decf0'
const POST_ID = '841339c7-591a-42e2-8233-7a0a00f0ed6f'
const CARGO_ID = '9a68df70-0267-42a8-bb5c-37f427e36ee4'

describe('NovaPostService.getWarehouses', () => {
	const findByCityRef = jest.fn().mockResolvedValue([])
	const service = new NovaPostService(
		{} as NovaPostCityRepository,
		{ findByCityRef } as unknown as NovaPostWarehouseRepository
	)

	beforeEach(() => findByCityRef.mockClear())

	it('asks for post and cargo branches together when the buyer picks «Відділення»', async () => {
		await service.getWarehouses('city', NovaPostWarehouseType.BRANCH, '12')

		expect(findByCityRef).toHaveBeenCalledWith('city', [POST_ID, CARGO_ID], '12')
	})

	it.each([
		[NovaPostWarehouseType.PARCEL_LOCKER, PARCEL_LOCKER_ID],
		[NovaPostWarehouseType.POST, POST_ID],
		[NovaPostWarehouseType.CARGO, CARGO_ID]
	])('keeps %s to its own Nova Post type', async (type, id) => {
		await service.getWarehouses('city', type)

		expect(findByCityRef).toHaveBeenCalledWith('city', [id], undefined)
	})

	it('does not filter by type when none is given', async () => {
		await service.getWarehouses('city')

		expect(findByCityRef).toHaveBeenCalledWith('city', undefined, undefined)
	})
})
