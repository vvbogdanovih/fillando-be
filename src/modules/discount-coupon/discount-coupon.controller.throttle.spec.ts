import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { throttlerTracker } from 'src/common/guards/throttler-tracker.util'
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

/**
 * Who a limit is counted against behind Cloudflare (P11): `main.ts` trusts one proxy hop, so the
 * edge is the address that hop reports — here the `X-Forwarded-For` entry it would append.
 */
describe('DiscountCouponController — the visitor behind Cloudflare', () => {
	const EDGE = '162.158.1.1'
	let app: INestApplication

	beforeEach(async () => {
		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
					skipIf: isInternalRequest,
					getTracker: throttlerTracker
				})
			],
			controllers: [DiscountCouponController],
			providers: [
				{
					provide: DiscountCouponService,
					useValue: { validateCoupon: jest.fn().mockResolvedValue({ valid: false }) }
				}
			]
		})
		;(app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }).set(
			'trust proxy',
			1
		)
	})

	afterEach(async () => {
		await app.close()
	})

	const validate = (headers: Record<string, string>) => {
		const req = send(app, 'post', '/discount-coupons/validate', {
			body: { code: 'ABCDEFGHIJ' }
		})
		for (const [name, value] of Object.entries(headers)) req.set(name, value)
		return req
	}

	it('gives two visitors through one edge an allowance each', async () => {
		const visitor = (ip: string) => ({ 'X-Forwarded-For': EDGE, 'CF-Connecting-IP': ip })
		for (let i = 0; i < LIMIT; i++)
			expect((await validate(visitor('203.0.113.7'))).status).toBe(201)
		expect((await validate(visitor('203.0.113.7'))).status).toBe(429)
		const other = await validate(visitor('198.51.100.9'))
		expect(other.status).toBe(201)
		expect(other.headers['x-ratelimit-remaining']).toBe(String(LIMIT - 1))
	})

	it('a request around Cloudflare cannot choose its key with the header', async () => {
		for (let i = 0; i < LIMIT; i++)
			expect((await validate({ 'CF-Connecting-IP': `203.0.113.${i + 1}` })).status).toBe(201)
		expect((await validate({ 'CF-Connecting-IP': '203.0.113.200' })).status).toBe(429)
	})
})
