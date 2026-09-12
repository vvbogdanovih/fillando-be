import { Category, CategorySchema } from 'src/database/mongoose/schemas/category.schema'
import { PartnerCatalogRepository } from 'src/database/mongoose/repositories/partner-catalog.repository'
import { PartnerCatalogService } from './partner-catalog.service'
import { PartnerCatalogController } from './partner-catalog.controller'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import {
	PartnerApiToken,
	PartnerApiTokenSchema
} from 'src/database/mongoose/schemas/partner-api-token.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { PartnerApiRepository } from 'src/database/mongoose/repositories/partner-api.repository'
import { PartnerApiService } from './partner-api.service'
import { PartnerApiController } from './partner-api.controller'
import { PartnerTokenController } from './partner-token.controller'
import {
	PartnerApiGuard,
	PartnerIpThrottlerGuard,
	PartnerTokenThrottlerGuard
} from './partner-api.guard'
@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Category.name, schema: CategorySchema },
			{ name: PartnerApiToken.name, schema: PartnerApiTokenSchema },
			{ name: ProductVariant.name, schema: ProductVariantSchema }
		])
	],
	providers: [
		PartnerCatalogRepository,
		PartnerCatalogService,
		PartnerApiRepository,
		PartnerApiService,
		PartnerApiGuard,
		PartnerIpThrottlerGuard,
		PartnerTokenThrottlerGuard
	],
	controllers: [PartnerApiController, PartnerCatalogController],
	exports: [PartnerApiService]
})
export class PartnerApiModule {}
@Module({ imports: [PartnerApiModule], controllers: [PartnerTokenController] })
export class PartnerTokenAdminModule {}
