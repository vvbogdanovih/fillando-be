import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { Order, OrderSchema } from 'src/database/mongoose/schemas/order.schema'
import { LandingModule } from '../landing/landing.module'
import { ProductModule } from '../product/product.module'
import { FeedController } from './feed.controller'
import { FeedCronService } from './feed-cron.service'
import { FeedService } from './feed.service'

/**
 * Google Shopping feed (TD-0006 §5.3). Owns no collection: it reads variants through
 * `ProductVariantRepository` and landings through `LandingRepository`, both exported by their
 * modules, and keeps the built XML in memory. `OrderRepository` is registered here for the
 * sales-velocity label — `OrderModule` exports only its service, and importing it would drag
 * the whole order graph in for one aggregate (the `ColorRepository`-in-`ProductModule` precedent).
 */
@Module({
	imports: [
		ProductModule,
		LandingModule,
		MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }])
	],
	controllers: [FeedController],
	providers: [FeedService, FeedCronService, OrderRepository]
})
export class FeedModule {}
