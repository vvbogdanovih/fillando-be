import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { PriceListService } from './price-list/price-list.service'
import { ProductController } from './product.controller'
import { ProductService } from './product.service'

/**
 * `GET /products/catalog` is the most expensive public read — three `$facet` aggregations per
 * request — and it had no limit at all, so a single client could hold Mongo busy for free.
 *
 * The handler's own `@Throttle` overrides the module default, so the limit asserted here is the
 * one the endpoint really enforces: raising it in the controller without raising it here fails.
 */
const LIMIT = 120

const CATALOG = `/products/catalog?category_id=${'0'.repeat(24)}`

describe('ProductController — rate limiting on the catalogue', () => {
	let app: INestApplication
	const productService = { getCatalog: jest.fn().mockResolvedValue({ items: [] }) }
	const priceListService = { generatePdf: jest.fn() }

	beforeEach(async () => {
		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
					skipIf: isInternalRequest
				})
			],
			controllers: [ProductController],
			providers: [
				{ provide: ProductService, useValue: productService },
				{ provide: PriceListService, useValue: priceListService }
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
		expect(productService.getCatalog).toHaveBeenCalledTimes(LIMIT)
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
