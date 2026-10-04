import { SchedulerRegistry } from '@nestjs/schedule'
import { ENV } from 'src/common/constants'
import type { FeedRefreshSignal } from 'src/common/services/feed-refresh.signal'
import type { StorefrontRevalidationService } from 'src/common/services/storefront-revalidation.service'
import type { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { PromoExpiryCronService } from './promo-expiry-cron.service'

const JOB_NAME = 'promo-expiry'

const build = (ended = 0) => {
	const variants = { countPromosEndedBetween: jest.fn().mockResolvedValue(ended) }
	const revalidation = { revalidate: jest.fn() }
	const feedRefresh = { request: jest.fn() }
	const registry = new SchedulerRegistry()
	const service = new PromoExpiryCronService(
		variants as unknown as ProductVariantRepository,
		registry,
		revalidation as unknown as StorefrontRevalidationService,
		feedRefresh as unknown as FeedRefreshSignal
	)
	return { service, variants, revalidation, feedRefresh, registry }
}

describe('PromoExpiryCronService', () => {
	const runCron = ENV.RUN_CRON
	afterEach(() => {
		;(ENV as { RUN_CRON: boolean }).RUN_CRON = runCron
	})

	it('registers nothing when RUN_CRON is off', () => {
		;(ENV as { RUN_CRON: boolean }).RUN_CRON = false
		const { service, registry } = build()
		service.onModuleInit()
		expect(() => registry.getCronJob(JOB_NAME)).toThrow()
	})

	it('registers the job when RUN_CRON is on', () => {
		;(ENV as { RUN_CRON: boolean }).RUN_CRON = true
		const { service, registry } = build()
		service.onModuleInit()
		const job = registry.getCronJob(JOB_NAME)
		expect(job).toBeDefined()
		void job.stop()
	})

	it('does nothing when no promotion ended since the last tick', async () => {
		const { service, feedRefresh, revalidation } = build(0)
		await service.handleTick(new Date('2026-10-04T12:10:00.000Z'))
		expect(revalidation.revalidate).not.toHaveBeenCalled()
		expect(feedRefresh.request).not.toHaveBeenCalled()
	})

	it('purges the storefront and asks for a feed rebuild when promotions ended', async () => {
		const { service, feedRefresh, revalidation } = build(2)
		await service.handleTick(new Date('2026-10-04T12:10:00.000Z'))
		expect(revalidation.revalidate).toHaveBeenCalledWith('products', 'promo expired (2)')
		// Through the signal, not FeedService directly: a generation already running is then
		// followed by another instead of swallowing the request.
		expect(feedRefresh.request).toHaveBeenCalledWith('promo expired (2)')
	})

	it('moves its watermark so each tick covers only the time since the previous one', async () => {
		const { service, variants } = build(0)
		const t1 = new Date('2026-10-04T12:10:00.000Z')
		const t2 = new Date('2026-10-04T12:20:00.000Z')
		await service.handleTick(t1)
		await service.handleTick(t2)
		const [[, to1], [from2, to2]] = variants.countPromosEndedBetween.mock.calls as [
			Date,
			Date
		][]
		expect(to1).toEqual(t1)
		expect(from2).toEqual(t1)
		expect(to2).toEqual(t2)
	})

	it('keeps the watermark when the count fails, so the window is retried and nothing is skipped', async () => {
		const { service, variants } = build(0)
		const t0 = new Date('2026-10-04T12:00:00.000Z')
		const t1 = new Date('2026-10-04T12:10:00.000Z')
		const t2 = new Date('2026-10-04T12:20:00.000Z')
		await service.handleTick(t0)
		variants.countPromosEndedBetween.mockRejectedValueOnce(new Error('mongo down'))
		await expect(service.handleTick(t1)).resolves.toBeUndefined()
		await service.handleTick(t2)
		const [from3] = variants.countPromosEndedBetween.mock.calls[2] as [Date, Date]
		expect(from3).toEqual(t0)
	})
})
