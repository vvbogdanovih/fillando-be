import { INestApplication, ServiceUnavailableException } from '@nestjs/common'
import { getLoggerToken } from 'nestjs-pino'
import { gzipSync } from 'node:zlib'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { FeedController } from './feed.controller'
import { FeedService } from './feed.service'

const feedService = {
	getVerifiedXml: jest.fn(),
	generate: jest.fn().mockResolvedValue({ item_count: 1 }),
	getStatus: jest.fn().mockReturnValue({ xml_ready: true })
}

type AdminRow = [method: HttpMethod, path: string, handler: jest.Mock]

/** The two admin operations: the manual regenerate button and the status screen. */
const ADMIN_ENDPOINTS: AdminRow[] = [
	['post', '/feeds/google-shopping/regenerate', feedService.generate],
	['get', '/feeds/google-shopping/status', feedService.getStatus]
]

describe('FeedController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [FeedController],
			providers: [
				{ provide: FeedService, useValue: feedService },
				{
					provide: getLoggerToken(FeedController.name),
					useValue: { info: jest.fn(), warn: jest.fn() }
				}
			]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
		const xml = '<?xml version="1.0"?><rss/>'
		feedService.getVerifiedXml.mockReturnValue({
			gzip: gzipSync(xml),
			bytes: Buffer.byteLength(xml),
			generatedAt: new Date('2026-09-06T10:00:00Z')
		})
	})

	describe('admin-only endpoints', () => {
		it.each(ADMIN_ENDPOINTS)('%s %s → 401 without a token', async (method, path, handler) => {
			const res = await send(app, method, path, {})
			expect(res.status).toBe(401)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_ENDPOINTS)('%s %s → 403 for USER', async (method, path, handler) => {
			const res = await send(app, method, path, { role: Role.USER })
			expect(res.status).toBe(403)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_ENDPOINTS)('%s %s → 2xx for ADMIN', async (method, path, handler) => {
			const res = await send(app, method, path, { role: Role.ADMIN })
			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			expect(handler).toHaveBeenCalledTimes(1)
		})
	})

	describe('the feed itself stays public', () => {
		it('GET /feeds/google-shopping.xml → 200 XML without a token', async () => {
			const res = await send(app, 'get', '/feeds/google-shopping.xml', {})

			expect(res.status).toBe(200)
			expect(res.headers['content-type']).toMatch(/application\/xml/)
			expect(res.headers['last-modified']).toBe('Sun, 06 Sep 2026 10:00:00 GMT')
			// The stored artifact is compressed; the response is the XML itself, sized, not chunked.
			expect(res.headers['content-length']).toBe('27')
			expect(res.headers['content-encoding']).toBeUndefined()
			expect(res.headers['transfer-encoding']).toBeUndefined()
			expect(res.text).toBe('<?xml version="1.0"?><rss/>')
		})

		it('returns non-cacheable JSON on a stale feed without XML headers', async () => {
			feedService.getVerifiedXml.mockRejectedValueOnce(
				new ServiceUnavailableException({
					message: 'Stale feed',
					details: { code: 'CATALOG_FEED_STALE' }
				})
			)
			const res = await send(app, 'get', '/feeds/google-shopping.xml')
			expect(res.status).toBe(503)
			expect(res.headers['retry-after']).toBe('5')
			expect(res.headers['cache-control']).toBe('no-store')
			expect(res.headers['content-type']).toContain('application/json')
			expect(res.headers['last-modified']).toBeUndefined()
		})

		it('answers 503 with Retry-After before the first generation — never an empty channel', async () => {
			feedService.getVerifiedXml.mockReturnValue(null)
			const res = await send(app, 'get', '/feeds/google-shopping.xml', {})

			expect(res.status).toBe(503)
			expect(res.headers['retry-after']).toBe('60')
			expect(res.headers['content-type']).not.toMatch(/xml/)
		})
	})
})
