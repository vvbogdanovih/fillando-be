import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { DiscountCouponController } from './discount-coupon.controller'
import { DiscountCouponService } from './discount-coupon.service'

/**
 * Rate limiting is per endpoint. POST /discount-coupons/validate is the cheapest guarded
 * handler to exercise: 20/min per IP, no body validation in the harness.
 */
const LIMIT = 20

describe('DiscountCouponController — rate limiting', () => {
	let app: INestApplication
	const service = {
		validateCoupon: jest.fn().mockResolvedValue({ valid: false, reason: 'NOT_FOUND' })
	}

	beforeEach(async () => {
		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
					skipIf: isInternalRequest
				})
			],
			controllers: [DiscountCouponController],
			providers: [{ provide: DiscountCouponService, useValue: service }]
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it(`answers 429 with Retry-After on request ${LIMIT + 1} within a minute`, async () => {
		for (let i = 0; i < LIMIT; i++) {
			const ok = await send(app, 'post', '/discount-coupons/validate', {
				body: { code: 'ABCDEFGHIJ' }
			})
			expect(ok.status).toBe(201)
		}

		const blocked = await send(app, 'post', '/discount-coupons/validate', {
			body: { code: 'ABCDEFGHIJ' }
		})

		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
		expect(service.validateCoupon).toHaveBeenCalledTimes(LIMIT)
	})

	it('never throttles requests carrying the internal token', async () => {
		for (let i = 0; i < LIMIT + 5; i++) {
			const res = await send(app, 'post', '/discount-coupons/validate', {
				body: { code: 'ABCDEFGHIJ' }
			}).set(INTERNAL_TOKEN_HEADER, ENV.INTERNAL_API_TOKEN as string)
			expect(res.status).toBe(201)
		}
	})

	it('a wrong internal token gets no exemption', async () => {
		let last = 0
		for (let i = 0; i < LIMIT + 1; i++) {
			const res = await send(app, 'post', '/discount-coupons/validate', {
				body: { code: 'ABCDEFGHIJ' }
			}).set(INTERNAL_TOKEN_HEADER, 'x'.repeat((ENV.INTERNAL_API_TOKEN as string).length))
			last = res.status
		}
		expect(last).toBe(429)
	})
})
