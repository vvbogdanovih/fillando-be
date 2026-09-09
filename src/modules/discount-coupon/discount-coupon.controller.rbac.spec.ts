import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { DiscountCouponController } from './discount-coupon.controller'
import { DiscountCouponService } from './discount-coupon.service'

const COUPON_ID = '000000000000000000000001'

const CREATE_BODY = { discount_percent: 15, valid_until: '2026-12-31T23:59:59.000Z' }
const UPDATE_BODY = { is_active: false }

const resolved = () => jest.fn().mockResolvedValue({})

const discountCouponService = {
	findAll: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	delete: resolved(),
	validateCoupon: jest.fn().mockResolvedValue({ valid: false, reason: 'NOT_FOUND' })
}

type ServiceMock = jest.Mock
type AdminRow = [
	method: HttpMethod,
	path: string,
	body: object | undefined,
	handler: ServiceMock,
	forwarded: unknown[]
]

/**
 * The coupon list is the whole discount programme in one response: `GET /discount-coupons`
 * returns every code in the shop, with its percentage and its remaining uses. If a USER could
 * read that list, every coupon is public — one logged-in visitor is enough to publish the
 * margin. The single-coupon read leaks the same thing one row at a time, and the three writes
 * let a caller mint a code for themselves. All five are
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
 *
 * The last column is what the handler must hand the service, and it is asserted because a
 * guarded endpoint that addresses the wrong coupon is a silent failure: swapping the route to
 * `@Get('/:couponId')` still matches the same URL while `@Param('id')` binds `undefined`, so
 * `findById(undefined)` answers 200 and only the argument shows it. The same holds for the two
 * bodies and for the list query — `is_active` / `q` / `page` / `limit` decide which coupons
 * come back, and a dropped `@Query()` returns the unfiltered programme instead.
 */
const ADMIN_ENDPOINTS: AdminRow[] = [
	[
		'get',
		'/discount-coupons?is_active=true&q=ZY64',
		undefined,
		discountCouponService.findAll,
		[expect.objectContaining({ is_active: 'true', q: 'ZY64' })]
	],
	[
		'get',
		`/discount-coupons/${COUPON_ID}`,
		undefined,
		discountCouponService.findById,
		[COUPON_ID]
	],
	['post', '/discount-coupons', CREATE_BODY, discountCouponService.create, [CREATE_BODY]],
	[
		'patch',
		`/discount-coupons/${COUPON_ID}`,
		UPDATE_BODY,
		discountCouponService.update,
		[COUPON_ID, UPDATE_BODY]
	],
	[
		'delete',
		`/discount-coupons/${COUPON_ID}`,
		undefined,
		discountCouponService.delete,
		[COUPON_ID]
	]
]

/**
 * `POST /discount-coupons/validate` is a **write-shaped read with no auth guard, on purpose**:
 * a shopper types a coupon into the checkout form, and a guest checkout means there is no
 * account to authenticate. Guarding it would break the discount field for everyone with
 * nothing in the logs — the field would just start answering 401 — which is why the anonymous
 * case is asserted here rather than left to a reader's judgement. It carries `ThrottlerGuard`
 * instead of `RolesGuard`; the 20/min limit and the `X-Internal-Token` bypass are pinned by
 * the sibling `discount-coupon.controller.throttle.spec.ts` and are not re-tested here (this
 * app boots the harness's permissive default throttler on purpose).
 */
describe('DiscountCouponController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [DiscountCouponController],
			providers: [{ provide: DiscountCouponService, useValue: discountCouponService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('the coupon programme is ADMIN-only', () => {
		/**
		 * Guard ORDER is proved by the 401 row and the ADMIN row together, never by one alone:
		 * `RolesGuard` reads `req.user.role`, so a swapped `@UseGuards(RolesGuard, JwtAuthGuard)`
		 * answers 403 to an anonymous caller as well as to a real ADMIN. A dropped
		 * `@Roles(Role.ADMIN)` is the mirror image — `RolesGuard` is default-deny, so it answers
		 * 403 to everyone and leaves the 401 and USER rows green.
		 */
		it.each(ADMIN_ENDPOINTS)(
			'%s %s → 401 without a token',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { body })

				expect(res.status).toBe(401)
				expect(handler).not.toHaveBeenCalled()
			}
		)

		it.each(ADMIN_ENDPOINTS)('%s %s → 403 for USER', async (method, path, body, handler) => {
			const res = await send(app, method, path, { role: Role.USER, body })

			expect(res.status).toBe(403)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_ENDPOINTS)(
			'%s %s → 2xx for ADMIN, forwarding the coupon it was asked about',
			async (method, path, body, handler, forwarded) => {
				const res = await send(app, method, path, { role: Role.ADMIN, body })

				expect(res.status).toBeGreaterThanOrEqual(200)
				expect(res.status).toBeLessThan(300)
				expect(handler).toHaveBeenCalledTimes(1)
				expect(handler).toHaveBeenCalledWith(...forwarded)
			}
		)
	})

	describe('the checkout coupon field stays public', () => {
		/**
		 * The role header is inert on this route — no auth guard reads it — so a logged-in
		 * shopper takes the very same path as a guest and needs no separate case.
		 *
		 * The response assertion is not a tautology: the mock deliberately answers «invalid», so
		 * a handler that calls the service and then makes up its own verdict — the plausible
		 * regression being `{ valid: true }` for every code, which gives the discount away —
		 * fails here even though the call itself still happened.
		 */
		it('POST /discount-coupons/validate → 201 and the service verdict, without a token', async () => {
			const res = await send(app, 'post', '/discount-coupons/validate', {
				body: { code: 'ABCDEFGHIJ' }
			})

			expect(res.status).toBe(201)
			expect(discountCouponService.validateCoupon).toHaveBeenCalledTimes(1)
			expect(discountCouponService.validateCoupon).toHaveBeenCalledWith('ABCDEFGHIJ')
			expect(res.body).toEqual({ valid: false, reason: 'NOT_FOUND' })
		})

		/**
		 * `POST /discount-coupons` (admin, mints a coupon) is declared above `POST /validate`,
		 * so the two share a method and a prefix. Neither shadows the other today — Express
		 * matches `/discount-coupons` exactly — but a `POST /:id` slipped in above `/validate`
		 * would swallow the checkout call into an admin handler, and the status code alone
		 * would not show it.
		 */
		it('routes /validate to the validator, never to the admin create handler', async () => {
			await send(app, 'post', '/discount-coupons/validate', { body: { code: 'ABCDEFGHIJ' } })

			expect(discountCouponService.create).not.toHaveBeenCalled()
			expect(discountCouponService.validateCoupon).toHaveBeenCalledTimes(1)
		})
	})
})
