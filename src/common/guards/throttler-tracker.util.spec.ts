import type { Request } from 'express'
import { throttlerTracker } from './throttler-tracker.util'

const request = (fields: Partial<Request>) => fields as Request

describe('throttlerTracker', () => {
	it('counts against the client at the head of the forwarded chain', async () => {
		// Behind Cloudflare and Nginx the chain is client, edge, proxy — and the default
		// `req.ip` would have been the edge, making every visitor through it one client.
		await expect(
			throttlerTracker(request({ ips: ['203.0.113.7', '162.158.1.1'], ip: '162.158.1.1' }))
		).resolves.toBe('203.0.113.7')
	})

	it('falls back to the socket address when nothing was forwarded', async () => {
		await expect(throttlerTracker(request({ ips: [], ip: '198.51.100.4' }))).resolves.toBe(
			'198.51.100.4'
		)
	})

	it('still returns a key when Express knows no address at all', async () => {
		// A missing key would make the limiter throw and take the handler down with it.
		await expect(throttlerTracker(request({}))).resolves.toBe('unknown')
	})
})
