import { Logger } from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import { ENV } from 'src/common/constants'
import { FeedCronService } from './feed-cron.service'
import type { FeedGenerationSummary } from './feed.types'

/** The name the service registers under; `SchedulerRegistry` is keyed by it. */
const JOB_NAME = 'google-shopping-feed'
const HOUR_MS = 60 * 60 * 1000

const summary = (overrides: Partial<FeedGenerationSummary> = {}): FeedGenerationSummary => ({
	ok: true,
	failure_reason: null,
	error: null,
	generated_at: new Date().toISOString(),
	duration_ms: 42,
	item_count: 3,
	in_stock: 3,
	out_of_stock: 0,
	typed_by_landing: 0,
	excluded: [],
	warnings: [],
	warning_kinds: 0,
	warned_items: 0,
	...overrides
})

/** A run that published nothing — refused rather than thrown (`feed.service.spec.ts`). */
const refused = () =>
	summary({
		ok: false,
		failure_reason: 'empty_feed',
		error: 'Фід не згенеровано: генерація дала 0 позицій (рядків каталогу: 4, виключено: 4).',
		item_count: 0,
		in_stock: 0
	})

/** `onModuleInit` fires the bootstrap run and forgets it; one macrotask drains that chain. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * A stand-in for `FeedService` that keeps the one promise the cron reads: `isRunning` is up for
 * exactly as long as a generation is in flight, so the overlap guard being tested is the cron's.
 */
const build = () => {
	let inFlight = 0
	const track = (result: Promise<FeedGenerationSummary>) => {
		inFlight++
		return result.finally(() => {
			inFlight--
		})
	}
	const feedService = {
		scheduled: false,
		get isRunning() {
			return inFlight > 0
		},
		generate: jest.fn(() => track(Promise.resolve(summary())))
	}
	const schedulerRegistry = new SchedulerRegistry()
	const service = new FeedCronService(feedService as never, schedulerRegistry)
	return { service, feedService, schedulerRegistry, track }
}

describe('FeedCronService', () => {
	let runCron: jest.ReplaceProperty<boolean>
	let logged: string[]
	let errors: string[]
	let rejections: unknown[]
	const collectRejection = (err: unknown) => rejections.push(err)
	let registry: SchedulerRegistry | null = null

	const withRunCron = (enabled: boolean) => {
		runCron = jest.replaceProperty(ENV, 'RUN_CRON', enabled)
	}

	beforeEach(() => {
		logged = []
		errors = []
		rejections = []
		jest.spyOn(Logger.prototype, 'log').mockImplementation(msg => void logged.push(String(msg)))
		jest.spyOn(Logger.prototype, 'error').mockImplementation(
			msg => void errors.push(String(msg))
		)
		process.on('unhandledRejection', collectRejection)
	})

	afterEach(() => {
		process.off('unhandledRejection', collectRejection)
		// A started job holds a timer for the next hour; jest would wait on it.
		if (registry?.doesExist('cron', JOB_NAME)) registry.deleteCronJob(JOB_NAME)
		registry = null
		runCron?.restore()
		jest.restoreAllMocks()
	})

	it('generates the feed as the process starts, so the public URL answers 503 for seconds and not for an hour', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()

		expect(feedService.generate).toHaveBeenCalledTimes(1)
		expect(logged).toContain('Google Shopping feed ready at startup: 3 items')
	})

	it('generates on bootstrap even where the hourly job is off — every replica serves the feed', async () => {
		withRunCron(false)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()

		expect(feedService.generate).toHaveBeenCalledTimes(1)
	})

	it('registers no schedule while RUN_CRON is off, so a second replica cannot generate in parallel', async () => {
		withRunCron(false)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()

		expect(schedulerRegistry.getCronJobs().size).toBe(0)
		// The status screen must not claim a schedule this process does not run.
		expect(feedService.scheduled).toBe(false)
		expect(logged).toContain(
			'RUN_CRON is off — hourly Google Shopping feed regeneration not registered'
		)
	})

	it('registers one started hourly job when RUN_CRON is on', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()

		expect([...schedulerRegistry.getCronJobs().keys()]).toEqual([JOB_NAME])
		const job = schedulerRegistry.getCronJob(JOB_NAME)
		// Registered is not enough: an unstarted job never fires.
		expect(job.isActive).toBe(true)
		// Hourly rather than daily, asserted through the schedule instead of its expression.
		const untilNextRun = job.nextDate().toMillis() - Date.now()
		expect(untilNextRun).toBeGreaterThan(0)
		expect(untilNextRun).toBeLessThanOrEqual(HOUR_MS)
		expect(feedService.scheduled).toBe(true)
	})

	it('keeps the process up and records the reason when the bootstrap generation throws', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry
		feedService.generate.mockImplementationOnce(() =>
			Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:27017'))
		)

		expect(() => service.onModuleInit()).not.toThrow()
		await flush()

		expect(errors).toContain(
			'Google Shopping feed not ready at startup: connect ECONNREFUSED 127.0.0.1:27017'
		)
		// A bootstrap failure must not reach the process as an unhandled rejection.
		expect(rejections).toEqual([])
		// And the hourly job is still registered: the next run is the recovery.
		expect(schedulerRegistry.doesExist('cron', JOB_NAME)).toBe(true)
	})

	it('reports a refused publish at startup instead of announcing a ready feed', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry
		feedService.generate.mockResolvedValueOnce(refused())

		service.onModuleInit()
		await flush()

		expect(errors).toEqual([
			`Google Shopping feed not published at startup: ${refused().error}`
		])
		expect(logged).not.toContain('Google Shopping feed ready at startup: 0 items')
	})

	it('skips a scheduled run while a generation is still in flight', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry, track } = build()
		registry = schedulerRegistry
		let release: (result: FeedGenerationSummary) => void = () => undefined
		feedService.generate.mockImplementationOnce(() =>
			track(new Promise<FeedGenerationSummary>(resolve => (release = resolve)))
		)

		// The bootstrap run is the one still going: exactly the collision Railway restarts make.
		service.onModuleInit()
		await flush()
		expect(feedService.isRunning).toBe(true)

		await schedulerRegistry.getCronJob(JOB_NAME).fireOnTick()
		await flush()

		expect(feedService.generate).toHaveBeenCalledTimes(1)
		expect(logged).toContain(
			'Scheduled feed regeneration skipped — a generation is already running'
		)
		expect(errors).toEqual([])

		release(summary())
		await flush()
	})

	it('runs on the tick once the previous generation has finished', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()
		await schedulerRegistry.getCronJob(JOB_NAME).fireOnTick()
		await flush()

		expect(feedService.generate).toHaveBeenCalledTimes(2)
		expect(errors).toEqual([])
	})

	it('catches a failing scheduled run so the job lives to the next hour', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry, track } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()
		feedService.generate.mockImplementationOnce(() => track(Promise.reject(new Error('boom'))))
		await schedulerRegistry.getCronJob(JOB_NAME).fireOnTick()
		await flush()

		expect(errors).toEqual(['Scheduled feed regeneration failed: boom'])
		expect(rejections).toEqual([])
		expect(schedulerRegistry.getCronJob(JOB_NAME).isActive).toBe(true)
		// The flag is back down, so the next hour is not locked out by the failure.
		expect(feedService.isRunning).toBe(false)
	})

	it('reports a scheduled run that published nothing', async () => {
		withRunCron(true)
		const { service, feedService, schedulerRegistry } = build()
		registry = schedulerRegistry

		service.onModuleInit()
		await flush()
		feedService.generate.mockResolvedValueOnce(refused())
		await schedulerRegistry.getCronJob(JOB_NAME).fireOnTick()
		await flush()

		expect(errors).toEqual([
			`Scheduled feed regeneration published nothing: ${refused().error}`
		])
	})
})
