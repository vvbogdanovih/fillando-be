import { Module } from '@nestjs/common'
import { LandingModule } from '../landing/landing.module'
import { ProductModule } from '../product/product.module'
import { FeedController } from './feed.controller'
import { FeedCronService } from './feed-cron.service'
import { FeedService } from './feed.service'

/**
 * Google Shopping feed (TD-0006 §5.3). Owns no collection: it reads variants through
 * `ProductVariantRepository` and landings through `LandingRepository`, both exported by their
 * modules, and keeps the built XML in memory.
 */
@Module({
	imports: [ProductModule, LandingModule],
	controllers: [FeedController],
	providers: [FeedService, FeedCronService]
})
export class FeedModule {}
