import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { ENV } from 'src/common/constants'
import {
	FeedRefreshSignal,
	feedRefresh as feedRefreshSignal
} from 'src/common/services/feed-refresh.signal'
import { FeedService } from './feed.service'

const JOB_NAME = 'google-shopping-feed'
const SCHEDULE = CronExpression.EVERY_HOUR

/**
 * Regenerates the feed on bootstrap and hourly (TD-0006 §5.3, "Key flow: Merchant fetch").
 *
 * The bootstrap run is unconditional: the public feed URL must answer 200 within seconds of a
 * restart, and on Railway restarts are routine. Only the hourly job honours `RUN_CRON`, the same
 * flag the Prom sync uses, so a second replica would never run two schedules.
 *
 * It also listens to {@link FeedRefreshSignal} — a promotion written in the admin must reach
 * Merchant before the hour lapses (TD-0012). That subscription is unconditional too: the XML
 * cache is per process, so every process has to rebuild its own copy.
 */
@Injectable()
export class FeedCronService implements OnModuleInit {
	private readonly logger = new Logger(FeedCronService.name)

	constructor(
		private readonly feedService: FeedService,
		private readonly schedulerRegistry: SchedulerRegistry,
		@Optional() private readonly feedRefresh: FeedRefreshSignal = feedRefreshSignal
	) {}

	onModuleInit(): void {
		void this.generateOnBootstrap()
		this.feedRefresh.subscribe(trigger => void this.regenerate(`requested by ${trigger}`))

		if (!ENV.RUN_CRON) {
			this.logger.log(
				'RUN_CRON is off — hourly Google Shopping feed regeneration not registered'
			)
			return
		}

		const job = new CronJob(SCHEDULE, () => {
			void this.regenerate('scheduled run')
		})
		this.schedulerRegistry.addCronJob(JOB_NAME, job)
		job.start()
		this.feedService.scheduled = true
		this.logger.log('Hourly Google Shopping feed regeneration registered')
	}

	private async generateOnBootstrap(): Promise<void> {
		try {
			const summary = await this.feedService.generate()
			if (!summary.ok) {
				// Refused, not published: zero items would delist the catalogue. The GET keeps
				// answering 503 until a run finds items.
				this.logger.error(
					`Google Shopping feed not published at startup: ${summary.error ?? summary.failure_reason}`
				)
				return
			}
			this.logger.log(`Google Shopping feed ready at startup: ${summary.item_count} items`)
		} catch (err) {
			// The public GET keeps answering 503 + Retry-After until the next run succeeds.
			this.logger.error(
				`Google Shopping feed not ready at startup: ${(err as Error).message}`
			)
		}
	}

	private async regenerate(reason: string): Promise<void> {
		if (this.feedService.isRunning) {
			// Queued inside FeedService, which runs it when the current generation ends —
			// whoever started that one: this cron, the bootstrap, or the admin's manual button.
			this.feedService.requestRerun()
			this.logger.log(
				`Feed regeneration (${reason}) queued — a generation is already running`
			)
			return
		}
		try {
			const summary = await this.feedService.generate()
			if (!summary.ok) {
				this.logger.error(
					`Feed regeneration (${reason}) published nothing: ${summary.error ?? summary.failure_reason}`
				)
			}
		} catch (err) {
			this.logger.error(`Feed regeneration (${reason}) failed: ${(err as Error).message}`)
		}
	}
}
