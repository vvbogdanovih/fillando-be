import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Landing, LandingSchema } from 'src/database/mongoose/schemas/landing.schema'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { CategoryModule } from 'src/modules/category/category.module'
import { ProductModule } from 'src/modules/product/product.module'
import { LandingService } from './landing.service'
import { LandingController } from './landing.controller'

@Module({
	// CategoryModule for CategoryRepository: a landing address is resolved by category slug.
	// ProductModule for ProductVariantRepository: the admin listing counts the products each
	// landing's pinned filters match, and publishing is refused when that count is zero.
	imports: [
		MongooseModule.forFeature([{ name: Landing.name, schema: LandingSchema }]),
		CategoryModule,
		ProductModule
	],
	controllers: [LandingController],
	providers: [LandingService, LandingRepository],
	exports: [LandingService, LandingRepository]
})
export class LandingModule {}
