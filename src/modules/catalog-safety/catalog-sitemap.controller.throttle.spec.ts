import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { CatalogSitemapController, CatalogSitemapService } from './catalog-sitemap'

/**
 * The backend sitemap is read by the storefront (with the internal token) and the release probes;
 * an outside caller made it scan every SKU per request without any limit. Owner decision
 * 31.10.2026: rate-limited per IP, the internal token exempt. Behind Cloudflare the per-IP key is
 * approximate until the real client IP is restored (separate task).
 */
const LIMIT = 10
const PATHS = ['/catalog/sitemap', '/catalog/sitemap/part?revision=1&epoch=1&from=a&to=b'] as const

describe('CatalogSitemapController — rate limiting', () => {
	let app: INestApplication
	const service = {
		index: jest.fn().mockResolvedValue({ revision: 1, epoch: 1, parts: [] }),
		part: jest.fn().mockResolvedValue({ variants: [], categories: [], landings: [] })
	}
	beforeEach(async () => {
		jest.clearAllMocks()
		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
					skipIf: isInternalRequest
				})
			],
			controllers: [CatalogSitemapController],
			providers: [{ provide: CatalogSitemapService, useValue: service }]
		})
	})
	afterEach(async () => {
		await app.close()
	})

	it.each(PATHS)(`serves ${LIMIT} requests a minute to %s, then answers 429`, async path => {
		for (let i = 0; i < LIMIT; i++) expect((await send(app, 'get', path)).status).toBe(200)
		const blocked = await send(app, 'get', path)
		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
	})

	it.each(PATHS)('never throttles %s for the internal token (storefront, probes)', async path => {
		for (let i = 0; i < LIMIT + 5; i++) {
			const res = await send(app, 'get', path).set(
				INTERNAL_TOKEN_HEADER,
				ENV.INTERNAL_API_TOKEN as string
			)
			expect(res.status).toBe(200)
		}
	})
})
