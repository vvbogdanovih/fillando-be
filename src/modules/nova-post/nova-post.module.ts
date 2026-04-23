import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import {
	NovaPostCity,
	NovaPostCitySchema
} from 'src/database/mongoose/schemas/nova-post-city.schema'
import {
	NovaPostWarehouse,
	NovaPostWarehouseSchema
} from 'src/database/mongoose/schemas/nova-post-warehouse.schema'
import { NovaPostCityRepository } from 'src/database/mongoose/repositories/nova-post-city.repository'
import { NovaPostWarehouseRepository } from 'src/database/mongoose/repositories/nova-post-warehouse.repository'
import { NovaPostService } from './nova-post.service'
import { NovaPostSyncService } from './nova-post-sync.service'
import { NovaPostController } from './nova-post.controller'

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: NovaPostCity.name, schema: NovaPostCitySchema },
			{ name: NovaPostWarehouse.name, schema: NovaPostWarehouseSchema }
		])
	],
	controllers: [NovaPostController],
	providers: [
		NovaPostService,
		NovaPostSyncService,
		NovaPostCityRepository,
		NovaPostWarehouseRepository
	]
})
export class NovaPostModule {}
