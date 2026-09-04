import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Landing, LandingSchema } from 'src/database/mongoose/schemas/landing.schema'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { CategoryModule } from 'src/modules/category/category.module'
import { LandingService } from './landing.service'
import { LandingController } from './landing.controller'

@Module({
	// CategoryModule for CategoryRepository: a landing address is resolved by category slug.
	imports: [
		MongooseModule.forFeature([{ name: Landing.name, schema: LandingSchema }]),
		CategoryModule
	],
	controllers: [LandingController],
	providers: [LandingService, LandingRepository],
	exports: [LandingService, LandingRepository]
})
export class LandingModule {}
