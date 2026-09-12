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
			{ name: PartnerApiToken.name, schema: PartnerApiTokenSchema },
			{ name: ProductVariant.name, schema: ProductVariantSchema }
		])
	],
	providers: [
		PartnerApiRepository,
		PartnerApiService,
		PartnerApiGuard,
		PartnerIpThrottlerGuard,
		PartnerTokenThrottlerGuard
	],
	controllers: [PartnerApiController],
	exports: [PartnerApiService]
})
export class PartnerApiModule {}
@Module({ imports: [PartnerApiModule], controllers: [PartnerTokenController] })
export class PartnerTokenAdminModule {}
