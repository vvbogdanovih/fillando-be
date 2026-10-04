import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { ENV } from 'src/common/constants'
import {
	FeedRefreshSignal,
	feedRefresh as feedRefreshSignal
} from 'src/common/services/feed-refresh.signal'
import {
	StorefrontRevalidationService,
	storefrontRevalidation
} from 'src/common/services/storefront-revalidation.service'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'

const JOB_NAME = 'promo-expiry'
const SCHEDULE = CronExpression.EVERY_10_MINUTES

/**
 * A promotion that ends on its own date changes every price surface without anyone writing to
 * the database (TD-0012): the sale price is derived on read, so the document is already right —
 * but the storefront's cached pages and the in-memory Merchant feed are not. This job looks
 * every ten minutes for promotions whose end fell since the last successful look and, when it
 * finds any, purges the storefront and asks for a feed rebuild. Nothing is written: the expired
 * values stay on the variant for the admin to see.
 *
 * The rebuild goes through {@link FeedRefreshSignal} rather than `FeedService.generate()`
 * directly, so a generation already in flight is followed by another instead of swallowing the
 * request. Gated by `RUN_CRON` like the other schedules, so a second replica never runs two.
 */
@Injectable()
export class PromoExpiryCronService implements OnModuleInit {
	private readonly logger = new Logger(PromoExpiryCronService.name)
	/**
	 * The instant the previous *successful* tick looked up to; the next tick covers
	 * `(lastCheckedAt, now]`. Advanced only after the count succeeds, so a failed tick retries
	 * the same window instead of skipping it.
	 */
	private lastCheckedAt = new Date()

	constructor(
		private readonly variants: ProductVariantRepository,
		private readonly schedulerRegistry: SchedulerRegistry,
		@Optional()
		private readonly revalidation: StorefrontRevalidationService = storefrontRevalidation,
		@Optional() private readonly feedRefresh: FeedRefreshSignal = feedRefreshSignal
	) {}

	onModuleInit(): void {
		if (!ENV.RUN_CRON) {
			this.logger.log('RUN_CRON is off — promotion expiry check not registered')
			return
		}
		const job = new CronJob(SCHEDULE, () => {
			void this.handleTick()
		})
		this.schedulerRegistry.addCronJob(JOB_NAME, job)
		job.start()
		this.logger.log('Promotion expiry check registered (every 10 minutes)')
	}

	async handleTick(now: Date = new Date()): Promise<void> {
		const from = this.lastCheckedAt
		let ended: number
		try {
			ended = await this.variants.countPromosEndedBetween(from, now)
		} catch (err) {
			this.logger.error(`Promotion expiry check failed: ${(err as Error).message}`)
			return
		}
		this.lastCheckedAt = now
		if (ended === 0) return
		this.logger.log(`${ended} promotion(s) ended since ${from.toISOString()} — refreshing`)
		this.revalidation.revalidate('products', `promo expired (${ended})`)
		this.feedRefresh.request(`promo expired (${ended})`)
	}
}
