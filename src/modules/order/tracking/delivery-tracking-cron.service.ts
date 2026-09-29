import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { ENV } from 'src/common/constants'
import { DeliveryTrackingService } from './delivery-tracking.service'

const JOB_NAME = 'nova-post-delivery-tracking'
const SCHEDULE = CronExpression.EVERY_HOUR

@Injectable()
export class DeliveryTrackingCronService implements OnModuleInit {
	private readonly logger = new Logger(DeliveryTrackingCronService.name)

	constructor(
		private readonly trackingService: DeliveryTrackingService,
		private readonly schedulerRegistry: SchedulerRegistry
	) {}

	onModuleInit(): void {
		if (!ENV.RUN_CRON) {
			this.logger.log('RUN_CRON is off — scheduled delivery tracking not registered')
			return
		}

		const job = new CronJob(SCHEDULE, () => {
			void this.handleScheduledRun()
		})
		this.schedulerRegistry.addCronJob(JOB_NAME, job)
		job.start()
		this.logger.log('Scheduled delivery tracking registered (every hour)')
	}

	private async handleScheduledRun(): Promise<void> {
		if (this.trackingService.isRunning) {
			this.logger.log('Scheduled delivery tracking skipped — a run is already in progress')
			return
		}

		try {
			const summary = await this.trackingService.run()
			this.logger.log(`Scheduled delivery tracking done: ${JSON.stringify(summary)}`)
		} catch (err) {
			this.logger.error(`Scheduled delivery tracking failed: ${(err as Error).message}`)
		}
	}
}
