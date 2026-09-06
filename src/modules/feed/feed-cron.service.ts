import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { ENV } from 'src/common/constants'
import { FeedService } from './feed.service'

const JOB_NAME = 'google-shopping-feed'
const SCHEDULE = CronExpression.EVERY_HOUR

/**
 * Regenerates the feed on bootstrap and hourly (TD-0006 §5.3, "Key flow: Merchant fetch").
 *
 * The bootstrap run is unconditional: the public feed URL must answer 200 within seconds of a
 * restart, and on Railway restarts are routine. Only the hourly job honours `RUN_CRON`, the same
 * flag the Prom sync uses, so a second replica would never run two schedules.
 */
@Injectable()
export class FeedCronService implements OnModuleInit {
	private readonly logger = new Logger(FeedCronService.name)

	constructor(
		private readonly feedService: FeedService,
		private readonly schedulerRegistry: SchedulerRegistry
	) {}

	onModuleInit(): void {
		void this.generateOnBootstrap()

		if (!ENV.RUN_CRON) {
			this.logger.log(
				'RUN_CRON is off — hourly Google Shopping feed regeneration not registered'
			)
			return
		}

		const job = new CronJob(SCHEDULE, () => {
			void this.handleScheduledRun()
		})
		this.schedulerRegistry.addCronJob(JOB_NAME, job)
		job.start()
		this.feedService.scheduled = true
		this.logger.log('Hourly Google Shopping feed regeneration registered')
	}

	private async generateOnBootstrap(): Promise<void> {
		try {
			const summary = await this.feedService.generate()
			this.logger.log(`Google Shopping feed ready at startup: ${summary.item_count} items`)
		} catch (err) {
			// The public GET keeps answering 503 + Retry-After until the next run succeeds.
			this.logger.error(
				`Google Shopping feed not ready at startup: ${(err as Error).message}`
			)
		}
	}

	private async handleScheduledRun(): Promise<void> {
		if (this.feedService.isRunning) {
			this.logger.log('Scheduled feed regeneration skipped — a generation is already running')
			return
		}
		try {
			await this.feedService.generate()
		} catch (err) {
			this.logger.error(`Scheduled feed regeneration failed: ${(err as Error).message}`)
		}
	}
}
