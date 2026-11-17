import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { PublicCatalogController } from './public-catalog.controller'
import { PublicCatalogService } from './public-catalog.service'
import { PublicProductService } from './public-product.service'

/**
 * `GET /products/catalog` is the most expensive public read — three `$facet` aggregations per
 * request — and it had no limit at all, so a single client could hold Mongo busy for free.
 *
 * The handler's own `@Throttle` overrides the module default, so the limit asserted here is the
 * one the endpoint really enforces: raising it in the controller without raising it here fails.
 */
const LIMIT = 120

const CATALOG = `/products/catalog?category_id=${'0'.repeat(24)}`

describe('PublicCatalogController — rate limiting on the catalogue', () => {
	let app: INestApplication
	const productService = { legacy: jest.fn().mockResolvedValue({ items: [] }) }

	beforeEach(async () => {
		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
					skipIf: isInternalRequest
				})
			],
			controllers: [PublicCatalogController],
			providers: [
				{ provide: PublicCatalogService, useValue: productService },
				{ provide: PublicProductService, useValue: {} }
			]
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it(`serves ${LIMIT} requests a minute, then answers 429 with Retry-After`, async () => {
		for (let i = 0; i < LIMIT; i++) {
			const ok = await send(app, 'get', CATALOG)
			expect(ok.status).toBe(200)
		}

		const blocked = await send(app, 'get', CATALOG)

		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
		expect(productService.legacy).toHaveBeenCalledTimes(LIMIT)
	})

	// The typed catalogue, its navigation counts (Plan-0010 B05/D06.5) and its product strip share
	// the same limit.
	it.each([
		['/products/catalog/v2?limit=1', 'read'],
		['/products/catalog/v2/category-counts', 'categoryCounts'],
		['/products/catalog/v2/strip?limit=1', 'strip']
	] as const)('limits %s to the same 120 a minute', async (path, handler) => {
		const service = productService as unknown as Record<string, jest.Mock>
		service[handler] = jest.fn().mockResolvedValue({})
		for (let i = 0; i < LIMIT; i++) expect((await send(app, 'get', path)).status).toBe(200)
		const blocked = await send(app, 'get', path)
		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
		expect(service[handler]).toHaveBeenCalledTimes(LIMIT)
	})

	it('never throttles requests carrying the internal token (our own SSR)', async () => {
		for (let i = 0; i < LIMIT + 5; i++) {
			const res = await send(app, 'get', CATALOG).set(
				INTERNAL_TOKEN_HEADER,
				ENV.INTERNAL_API_TOKEN as string
			)
			expect(res.status).toBe(200)
		}
	})
})
