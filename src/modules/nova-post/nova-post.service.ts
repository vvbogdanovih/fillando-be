import { Injectable } from '@nestjs/common'
import { NovaPostCityRepository } from 'src/database/mongoose/repositories/nova-post-city.repository'
import { NovaPostWarehouseRepository } from 'src/database/mongoose/repositories/nova-post-warehouse.repository'
import { NovaPostCity } from 'src/database/mongoose/schemas/nova-post-city.schema'
import { NovaPostWarehouse } from 'src/database/mongoose/schemas/nova-post-warehouse.schema'
import { NovaPostWarehouseType } from 'src/common/types/enums'
import { NOVA_POST_WAREHOUSE_TYPE_ID } from 'src/common/constants'

@Injectable()
export class NovaPostService {
	constructor(
		private readonly cityRepo: NovaPostCityRepository,
		private readonly warehouseRepo: NovaPostWarehouseRepository
	) {}

	searchCities(q: string): Promise<NovaPostCity[]> {
		return this.cityRepo.search(q)
	}

	getWarehouses(
		cityRef: string,
		type?: NovaPostWarehouseType,
		q?: string
	): Promise<NovaPostWarehouse[]> {
		const typeOfWarehouse = type ? NOVA_POST_WAREHOUSE_TYPE_ID[type] : undefined
		return this.warehouseRepo.findByCityRef(cityRef, typeOfWarehouse, q)
	}
}
