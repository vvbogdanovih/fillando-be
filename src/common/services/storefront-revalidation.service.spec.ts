import { Logger } from '@nestjs/common'
import axios from 'axios'
import { ENV } from 'src/common/constants'
import { StorefrontRevalidationService } from './storefront-revalidation.service'

/**
 * The purge is HTTP, so the transport is mocked; what is under test is *how many* requests a
 * given sequence of admin writes produces, and that a failure stays inside the service.
 *
 * The Prom availability sync rewrites stock and price for the whole catalogue one variant at a
 * time. A purge per write would be hundreds of requests against a single Next process, all
 * expiring the same coarse tag — the storm this class exists to bound.
 */
jest.mock('axios', () => ({
	__esModule: true,
	default: {
		post: jest.fn().mockResolvedValue({ status: 200 }),
		isAxiosError: (error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError
	}
}))
// eslint-disable-next-line @typescript-eslint/unbound-method -- the mocked module's method, read once
const axiosPost = axios.post as jest.Mock

jest.mock('src/common/constants', () => ({
	ENV: { FRONTEND_URL: 'https://storefront.invalid/', REVALIDATE_SECRET: 's'.repeat(32) }
}))

const env = ENV as { FRONTEND_URL: string; REVALIDATE_SECRET?: string }
const SECRET = 's'.repeat(32)
const THROTTLE_WINDOW_MS = 5000
const RETRY_PAUSE_MS = 2000

type PostCall = [string, { resource: string }, { headers: Record<string, string> }]

const calls = (): PostCall[] => axiosPost.mock.calls as PostCall[]
const lastCall = (): PostCall => calls()[calls().length - 1]

describe('StorefrontRevalidationService', () => {
	let service: StorefrontRevalidationService

	beforeEach(() => {
		jest.useFakeTimers()
		jest.clearAllMocks()
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
		jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
		axiosPost.mockResolvedValue({ status: 200 })
		env.REVALIDATE_SECRET = SECRET
		service = new StorefrontRevalidationService()
	})

	afterEach(() => {
		jest.useRealTimers()
		jest.restoreAllMocks()
	})

	it('names the resource and nothing else, and carries the shared secret', () => {
		service.revalidate('products', 'variant update')

		expect(axiosPost).toHaveBeenCalledTimes(1)
		const [url, body, config] = lastCall()
		// The trailing slash of FRONTEND_URL must not survive into the path.
		expect(url).toBe('https://storefront.invalid/api/revalidate')
		expect(body).toEqual({ resource: 'products' })
		expect(config.headers).toMatchObject({
			'Content-Type': 'application/json',
			'x-revalidate-secret': SECRET
		})
	})

	it('sends no secret header when none is configured', () => {
		// Supported state: outside production the storefront accepts the call without one.
		env.REVALIDATE_SECRET = undefined

		service.revalidate('categories', 'category update')

		expect(lastCall()[2].headers).not.toHaveProperty('x-revalidate-secret')
	})

	it('purges the first write of a burst immediately, so an ordinary save is never delayed', () => {
		service.revalidate('products', 'variant update')

		expect(axiosPost).toHaveBeenCalledTimes(1)
	})

	it('collapses a burst into one trailing purge instead of one request per write', () => {
		for (let i = 0; i < 50; i++) service.revalidate('products', 'prom sync')

		// One leading purge; the other 49 writes are owed, not sent.
		expect(axiosPost).toHaveBeenCalledTimes(1)

		jest.advanceTimersByTime(THROTTLE_WINDOW_MS)

		// …and settled by a single trailing purge that carries the last of them.
		expect(axiosPost).toHaveBeenCalledTimes(2)
	})

	it('stops purging once the writes stop', () => {
		service.revalidate('products', 'variant update')
		service.revalidate('products', 'variant update')

		jest.advanceTimersByTime(THROTTLE_WINDOW_MS) // trailing purge
		jest.advanceTimersByTime(THROTTLE_WINDOW_MS) // nothing owed
		jest.advanceTimersByTime(THROTTLE_WINDOW_MS)

		expect(axiosPost).toHaveBeenCalledTimes(2)
	})

	it('keeps a long sync at one purge per window rather than resuming one per write', () => {
		// The window is re-opened by the trailing purge, not merely closed: otherwise the next
		// write after it starts a fresh leading purge and a slow sync is back to a storm.
		for (let i = 0; i < 10; i++) service.revalidate('products', 'prom sync')
		jest.advanceTimersByTime(THROTTLE_WINDOW_MS)
		for (let i = 0; i < 10; i++) service.revalidate('products', 'prom sync')

		expect(axiosPost).toHaveBeenCalledTimes(2)
	})

	it('purges immediately again once the window has lapsed empty', () => {
		service.revalidate('products', 'variant update')
		jest.advanceTimersByTime(THROTTLE_WINDOW_MS)

		service.revalidate('products', 'variant update')

		expect(axiosPost).toHaveBeenCalledTimes(2)
	})

	it('throttles each resource on its own window', () => {
		service.revalidate('products', 'variant update')
		service.revalidate('categories', 'category update')
		service.revalidate('landings', 'landing update')

		expect(axiosPost).toHaveBeenCalledTimes(3)
		expect(calls().map(call => call[1])).toEqual([
			{ resource: 'products' },
			{ resource: 'categories' },
			{ resource: 'landings' }
		])
	})

	it('a failed purge is a warning, never an exception the admin write could see', async () => {
		axiosPost.mockRejectedValue(new Error('ECONNREFUSED'))
		const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

		expect(() => service.revalidate('products', 'variant update')).not.toThrow()
		await jest.advanceTimersByTimeAsync(2 * RETRY_PAUSE_MS)

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed'))
	})

	// Owner decision 31.10.2026: no outbox before the release; a purge that fails is retried
	// three times with a pause, and the last failure names what stays stale for up to an hour.
	it('retries a failed purge three times with a pause, then warns once with the stale paths', async () => {
		axiosPost.mockRejectedValue(new Error('ECONNREFUSED'))
		const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
		service.revalidate('categories', 'category seo')
		await jest.advanceTimersByTimeAsync(0)
		expect(axiosPost).toHaveBeenCalledTimes(1)
		await jest.advanceTimersByTimeAsync(RETRY_PAUSE_MS)
		expect(axiosPost).toHaveBeenCalledTimes(2)
		expect(warn).not.toHaveBeenCalled()
		await jest.advanceTimersByTimeAsync(RETRY_PAUSE_MS)
		expect(axiosPost).toHaveBeenCalledTimes(3)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toMatch(/after 3 attempts/)
		expect(warn.mock.calls[0][0]).toContain('/catalog, /{category}, /{category}/{landing}')
		await jest.advanceTimersByTimeAsync(10 * RETRY_PAUSE_MS)
		expect(axiosPost).toHaveBeenCalledTimes(3)
	})

	it('a retry that gets through is a purge like any other', async () => {
		axiosPost.mockRejectedValueOnce(new Error('ETIMEDOUT')).mockResolvedValue({ status: 200 })
		const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
		const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
		service.revalidate('landings', 'typed landing')
		await jest.advanceTimersByTimeAsync(RETRY_PAUSE_MS)
		expect(axiosPost).toHaveBeenCalledTimes(2)
		expect(warn).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith(expect.stringContaining('purged'))
	})

	it('does not retry a refusal that a retry cannot change (a wrong secret)', async () => {
		axiosPost.mockRejectedValue(
			Object.assign(new Error('Request failed with status code 401'), {
				isAxiosError: true,
				response: { status: 401 }
			})
		)
		const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
		service.revalidate('products', 'variant update')
		await jest.advanceTimersByTimeAsync(3 * RETRY_PAUSE_MS)
		expect(axiosPost).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toMatch(/\(401\).*after 1 attempt/)
	})
})
