import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { CronExpression, SchedulerRegistry } from '@nestjs/schedule'
import { CronJob } from 'cron'
import { ENV } from 'src/common/constants'
import { PromSyncService } from './prom-sync.service'

const JOB_NAME = 'prom-availability-sync'
const SCHEDULE = CronExpression.EVERY_30_MINUTES

@Injectable()
export class PromCronService implements OnModuleInit {
	private readonly logger = new Logger(PromCronService.name)

	constructor(
		private readonly syncService: PromSyncService,
		private readonly schedulerRegistry: SchedulerRegistry
	) {}

	onModuleInit(): void {
		if (!ENV.RUN_CRON) {
			this.logger.log('RUN_CRON is off — scheduled Prom availability sync not registered')
			return
		}

		const job = new CronJob(SCHEDULE, () => {
			void this.handleScheduledSync()
		})
		this.schedulerRegistry.addCronJob(JOB_NAME, job as never)
		job.start()
		this.logger.log('Scheduled Prom availability sync registered (every 30 minutes)')
	}

	private async handleScheduledSync(): Promise<void> {
		if (this.syncService.isRunning) {
			this.logger.log('Scheduled Prom sync skipped — a sync is already running')
			return
		}

		this.logger.log('Scheduled Prom availability sync started')
		try {
			const summary = await this.syncService.syncAvailability()
			this.logger.log(`Scheduled Prom availability sync done: ${JSON.stringify(summary)}`)
		} catch (err) {
			this.logger.error(`Scheduled Prom availability sync failed: ${(err as Error).message}`)
		}
	}
}
