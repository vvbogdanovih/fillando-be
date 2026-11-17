import type { Request } from 'express'
import { clientIp, CLOUDFLARE_RANGES, fromCloudflare } from './client-ip.util'
import { throttlerTracker } from './throttler-tracker.util'

const request = (fields: Partial<Request>) => fields as Request
const EDGE = '162.158.1.1'

describe('throttlerTracker', () => {
	it('counts a visitor behind a Cloudflare edge by CF-Connecting-IP', async () => {
		// The default `req.ip` would be the edge, making every visitor through it one client.
		await expect(
			throttlerTracker(request({ ip: EDGE, headers: { 'cf-connecting-ip': '203.0.113.7' } }))
		).resolves.toBe('203.0.113.7')
		await expect(
			throttlerTracker(request({ ip: EDGE, headers: { 'cf-connecting-ip': '198.51.100.9' } }))
		).resolves.toBe('198.51.100.9')
	})

	it('ignores the header from anyone but Cloudflare: a request around it keeps its own address', async () => {
		await expect(
			throttlerTracker(
				request({ ip: '198.51.100.4', headers: { 'cf-connecting-ip': '203.0.113.7' } })
			)
		).resolves.toBe('198.51.100.4')
	})

	it('never reads the client-written head of X-Forwarded-For', async () => {
		await expect(
			throttlerTracker(
				request({
					ip: '198.51.100.4',
					ips: ['203.0.113.250', '198.51.100.4'],
					headers: { 'x-forwarded-for': '203.0.113.250, 198.51.100.4' }
				})
			)
		).resolves.toBe('198.51.100.4')
	})

	it('keeps the edge when Cloudflare sent no usable visitor address', async () => {
		await expect(throttlerTracker(request({ ip: EDGE, headers: {} }))).resolves.toBe(EDGE)
		await expect(
			throttlerTracker(request({ ip: EDGE, headers: { 'cf-connecting-ip': 'not-an-ip' } }))
		).resolves.toBe(EDGE)
	})

	it('still returns a key when Express knows no address at all', async () => {
		// A missing key would make the limiter throw and take the handler down with it.
		await expect(throttlerTracker(request({}))).resolves.toBe('unknown')
	})
})

describe('fromCloudflare', () => {
	it('knows the edges in both families, IPv4-mapped included, and nothing else', () => {
		expect(fromCloudflare('104.16.0.1')).toBe(true)
		expect(fromCloudflare('::ffff:172.64.1.1')).toBe(true)
		expect(fromCloudflare('2606:4700:10::6814:1')).toBe(true)
		expect(fromCloudflare('203.0.113.7')).toBe(false)
		expect(fromCloudflare('10.0.0.1')).toBe(false)
		expect(fromCloudflare('')).toBe(false)
		expect(CLOUDFLARE_RANGES).toHaveLength(22)
	})

	it('takes an IPv6 visitor too', () => {
		expect(
			clientIp(
				request({ ip: '2a06:98c0::1', headers: { 'cf-connecting-ip': '2001:db8::7' } })
			)
		).toBe('2001:db8::7')
	})
})
