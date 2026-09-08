import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import type { Request } from 'express'
import passport from 'passport'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, HttpMethod, send, TEST_ROLE_HEADER } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { OrderController } from './order.controller'
import { OrderService } from './order.service'

const ORDER_ID = '000000000000000000000001'
const ORDER_NUMBER = 'FL-000123'
const LOOKUP_TOKEN = 'a'.repeat(32)

/**
 * `POST /orders` is the one handler in this controller that keeps a **real** guard the harness
 * does not replace: `OptionalJwtAuthGuard` (the harness overrides `JwtAuthGuard` only). That
 * guard is passport, so the spec registers a stand-in `'jwt'` strategy following the same
 * `x-test-role` convention as the harness — no header → `fail()` (a guest), header → `success()`
 * with that role. The guard under test stays the production one; only the token verification it
 * delegates to is stubbed, which is what makes the guest-checkout assertions below meaningful.
 */
class HeaderRoleJwtStrategy implements passport.Strategy {
	name = 'jwt'

	authenticate(this: passport.StrategyCreated<HeaderRoleJwtStrategy>, req: Request) {
		const role = req.header(TEST_ROLE_HEADER)
		if (!role) {
			this.fail(401)
			return
		}

		this.success({ id: 'u1', email: 'u1@test.invalid', name: 'Test', role })
	}
}

passport.use('jwt', new HeaderRoleJwtStrategy())

const resolved = () => jest.fn().mockResolvedValue({})

const orderService = {
	create: resolved(),
	findAll: resolved(),
	generateReport: jest
		.fn()
		.mockResolvedValue({ buffer: Buffer.from('pdf'), filename: 'report.pdf' }),
	findMyOrders: resolved(),
	findMyOrderById: resolved(),
	getPaymentStatusPublic: resolved(),
	findById: resolved(),
	changePaymentMethodPublic: resolved(),
	changeMyPaymentMethod: resolved(),
	update: resolved(),
	updateOrderStatus: resolved(),
	updatePaymentStatus: resolved(),
	setTtn: resolved(),
	generateInvoice: jest
		.fn()
		.mockResolvedValue({ buffer: Buffer.from('pdf'), orderNumber: ORDER_NUMBER }),
	sendVendorEmail: resolved()
}

type Row = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

/**
 * The order-management screens. Everything here reads or writes somebody else's order —
 * customer name, phone, address, the supplier email, the money — so all of it carries
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
 *
 * `POST /orders/report` and `POST /orders/:id/invoice` stream a PDF through `@Res()`; a guard
 * regression there leaks the whole order book as a downloadable file, which is why they are
 * rows in this table and not an afterthought.
 */
const ADMIN_ENDPOINTS: Row[] = [
	['get', '/orders', undefined, orderService.findAll],
	['post', '/orders/report', {}, orderService.generateReport],
	['get', `/orders/${ORDER_ID}`, undefined, orderService.findById],
	['patch', `/orders/${ORDER_ID}`, {}, orderService.update],
	['patch', `/orders/${ORDER_ID}/status`, {}, orderService.updateOrderStatus],
	['patch', `/orders/${ORDER_ID}/payment-status`, {}, orderService.updatePaymentStatus],
	['patch', `/orders/${ORDER_ID}/ttn`, {}, orderService.setTtn],
	['post', `/orders/${ORDER_ID}/invoice`, {}, orderService.generateInvoice],
	['post', `/orders/${ORDER_ID}/vendor-email`, {}, orderService.sendVendorEmail]
]

/**
 * User-owned routes: `JwtAuthGuard` alone, **no** `RolesGuard`, and the service scopes every
 * query by the caller's id. A plain USER must get through — adding `@Roles(Role.ADMIN)` here
 * would take "мої замовлення" away from every customer, and `PATCH /orders/me/:id/payment-method`
 * is a write, so a sweep for unguarded writes is exactly how that happens.
 */
const OWN_ORDER_ENDPOINTS: Row[] = [
	['get', '/orders/me', undefined, orderService.findMyOrders],
	['get', `/orders/me/${ORDER_ID}`, undefined, orderService.findMyOrderById],
	['patch', `/orders/me/${ORDER_ID}/payment-method`, {}, orderService.changeMyPaymentMethod]
]

/**
 * Deliberately reachable with no token at all — the three endpoints a guest uses.
 *
 * `POST /orders` is guest checkout (`OptionalJwtAuthGuard`: a token is used when present,
 * never required). The two `/lookup/:orderNumber` routes carry the buyer's capability token in
 * the query string and are verified inside the service (HMAC, see `LIQPAY_FLOW.md`), so the
 * guard chain must let an anonymous request reach the handler. Closing any of them with
 * `JwtAuthGuard` breaks checkout or the "статус замовлення" link that the confirmation email
 * sends to every guest — silently, with a 401 no shopper can act on.
 */
const PUBLIC_ENDPOINTS: Row[] = [
	['post', '/orders', {}, orderService.create],
	[
		'get',
		`/orders/lookup/${ORDER_NUMBER}?token=${LOOKUP_TOKEN}`,
		undefined,
		orderService.getPaymentStatusPublic
	],
	[
		'patch',
		`/orders/lookup/${ORDER_NUMBER}/payment-method?token=${LOOKUP_TOKEN}`,
		{},
		orderService.changePaymentMethodPublic
	]
]

describe('OrderController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [OrderController],
			providers: [{ provide: OrderService, useValue: orderService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('order management is ADMIN-only', () => {
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

		it.each(ADMIN_ENDPOINTS)('%s %s → 2xx for ADMIN', async (method, path, body, handler) => {
			const res = await send(app, method, path, { role: Role.ADMIN, body })

			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			expect(handler).toHaveBeenCalledTimes(1)
		})

		it('passes control through the guard chain to the service exactly once for ADMIN', async () => {
			await send(app, 'patch', `/orders/${ORDER_ID}/status`, {
				role: Role.ADMIN,
				body: { status: 'shipped' }
			})

			expect(orderService.updateOrderStatus).toHaveBeenCalledTimes(1)
			expect(orderService.updateOrderStatus).toHaveBeenCalledWith(ORDER_ID, {
				status: 'shipped'
			})
		})
	})

	/**
	 * Guards in one `@UseGuards(...)` run left to right and `RolesGuard` reads `req.user.role`,
	 * so `JwtAuthGuard` has to come first. Swapped, `RolesGuard` answers before the token is
	 * validated: the anonymous caller sees 403 instead of 401 and — the half that stops the
	 * business — a real ADMIN sees 403 too and cannot touch a single order.
	 */
	describe('JwtAuthGuard runs before RolesGuard', () => {
		it('answers 401, not 403, when an admin write carries no token', async () => {
			const res = await send(app, 'patch', `/orders/${ORDER_ID}/ttn`, { body: {} })

			expect(res.status).toBe(401)
		})

		it('lets an ADMIN set the TTN, which a RolesGuard-first chain never would', async () => {
			const res = await send(app, 'patch', `/orders/${ORDER_ID}/ttn`, {
				role: Role.ADMIN,
				body: { ttn: '20450000000000' }
			})

			expect(res.status).toBe(200)
			expect(orderService.setTtn).toHaveBeenCalledTimes(1)
		})
	})

	describe('own-order endpoints need a token but no role', () => {
		it.each(OWN_ORDER_ENDPOINTS)(
			'%s %s → 401 without a token',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { body })

				expect(res.status).toBe(401)
				expect(handler).not.toHaveBeenCalled()
			}
		)

		it.each(OWN_ORDER_ENDPOINTS)(
			'%s %s → 200 for a plain USER',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { role: Role.USER, body })

				expect(res.status).toBe(200)
				expect(handler).toHaveBeenCalledTimes(1)
			}
		)

		it('scopes the read by the authenticated caller, not by a parameter', async () => {
			await send(app, 'get', '/orders/me', { role: Role.USER })

			expect(orderService.findMyOrders).toHaveBeenCalledWith('u1', expect.anything())
		})
	})

	describe('guest endpoints stay open', () => {
		it.each(PUBLIC_ENDPOINTS)(
			'%s %s → 2xx without a token',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { body })

				expect(res.status).toBeGreaterThanOrEqual(200)
				expect(res.status).toBeLessThan(300)
				expect(handler).toHaveBeenCalledTimes(1)
			}
		)

		it('places a guest order with no user id attached', async () => {
			const res = await send(app, 'post', '/orders', { body: { items: [] } })

			expect(res.status).toBe(201)
			expect(orderService.create).toHaveBeenCalledWith({ items: [] }, undefined)
		})

		it('attaches the user id when the same checkout carries a token', async () => {
			const res = await send(app, 'post', '/orders', {
				role: Role.USER,
				body: { items: [] }
			})

			expect(res.status).toBe(201)
			expect(orderService.create).toHaveBeenCalledWith({ items: [] }, 'u1')
		})

		/**
		 * The capability token is checked in the service, never by a guard. If the guard chain
		 * short-circuited the request the service would never see the token — and a token that is
		 * never verified is a public order book.
		 */
		it('hands the lookup token to the service instead of validating it in a guard', async () => {
			await send(app, 'get', `/orders/lookup/${ORDER_NUMBER}?token=${LOOKUP_TOKEN}`)

			expect(orderService.getPaymentStatusPublic).toHaveBeenCalledWith(
				ORDER_NUMBER,
				LOOKUP_TOKEN
			)
		})
	})

	/** '/me' and '/lookup/:orderNumber' are declared before '/:id' — reversed, both become admin reads. */
	describe('route order keeps the guest and own-order paths off the admin handler', () => {
		it("resolves '/orders/me' to findMyOrders and not to the ':id' route", async () => {
			await send(app, 'get', '/orders/me', { role: Role.USER })

			expect(orderService.findMyOrders).toHaveBeenCalledTimes(1)
			expect(orderService.findById).not.toHaveBeenCalled()
		})

		it("resolves '/orders/lookup/:orderNumber' to the public lookup, not to the ':id' route", async () => {
			await send(app, 'get', `/orders/lookup/${ORDER_NUMBER}?token=${LOOKUP_TOKEN}`)

			expect(orderService.getPaymentStatusPublic).toHaveBeenCalledTimes(1)
			expect(orderService.findById).not.toHaveBeenCalled()
		})
	})
})

/**
 * `ThrottlerGuard` is a guard like the other two, and the audit names it in the same breath as
 * the role guards: "зняття тротлера з login/orders не буде спіймана тестами". The limits come
 * from the handlers' own `@Throttle` decorators and from the table in
 * `src/docs/API_AND_SWAGGER.md` §4a — raising one in the controller without raising it here
 * fails, which is the point.
 *
 * Every throttled endpoint of this controller is unauthenticated, so the limit is the only
 * thing standing between the order collection and a script: `POST /orders` writes a document
 * per request, and the two `/lookup` routes let a caller probe order numbers.
 */
describe('OrderController — rate limiting on the guest endpoints', () => {
	let app: INestApplication

	const LIMITS = {
		create: 10,
		lookup: 30,
		changePaymentMethod: 5
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
			controllers: [OrderController],
			providers: [{ provide: OrderService, useValue: orderService }]
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it(`accepts ${LIMITS.create} orders a minute from one IP, then answers 429 with Retry-After`, async () => {
		for (let i = 0; i < LIMITS.create; i++) {
			const ok = await send(app, 'post', '/orders', { body: { items: [] } })
			expect(ok.status).toBe(201)
		}

		const blocked = await send(app, 'post', '/orders', { body: { items: [] } })

		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
		expect(orderService.create).toHaveBeenCalledTimes(LIMITS.create)
	})

	it(`serves ${LIMITS.lookup} order lookups a minute, then answers 429`, async () => {
		const path = `/orders/lookup/${ORDER_NUMBER}?token=${LOOKUP_TOKEN}`

		for (let i = 0; i < LIMITS.lookup; i++) {
			const ok = await send(app, 'get', path)
			expect(ok.status).toBe(200)
		}

		const blocked = await send(app, 'get', path)

		expect(blocked.status).toBe(429)
		expect(blocked.headers['retry-after']).toBeDefined()
		expect(orderService.getPaymentStatusPublic).toHaveBeenCalledTimes(LIMITS.lookup)
	})

	it(`allows ${LIMITS.changePaymentMethod} payment-method changes a minute, then answers 429`, async () => {
		const path = `/orders/lookup/${ORDER_NUMBER}/payment-method?token=${LOOKUP_TOKEN}`

		for (let i = 0; i < LIMITS.changePaymentMethod; i++) {
			const ok = await send(app, 'patch', path, { body: {} })
			expect(ok.status).toBe(200)
		}

		const blocked = await send(app, 'patch', path, { body: {} })

		expect(blocked.status).toBe(429)
		expect(orderService.changePaymentMethodPublic).toHaveBeenCalledTimes(
			LIMITS.changePaymentMethod
		)
	})

	/** Each handler counts its own requests — a spent checkout limit must not block the lookup. */
	it('counts the limits per endpoint, not per controller', async () => {
		for (let i = 0; i < LIMITS.create + 1; i++) {
			await send(app, 'post', '/orders', { body: { items: [] } })
		}

		const lookup = await send(
			app,
			'get',
			`/orders/lookup/${ORDER_NUMBER}?token=${LOOKUP_TOKEN}`
		)

		expect(lookup.status).toBe(200)
	})

	it('never throttles requests carrying the internal token (our own SSR)', async () => {
		for (let i = 0; i < LIMITS.create + 5; i++) {
			const res = await send(app, 'post', '/orders', { body: { items: [] } }).set(
				INTERNAL_TOKEN_HEADER,
				ENV.INTERNAL_API_TOKEN as string
			)
			expect(res.status).toBe(201)
		}
	})

	it('gives a wrong internal token no exemption', async () => {
		let last = 0
		for (let i = 0; i < LIMITS.create + 1; i++) {
			const res = await send(app, 'post', '/orders', { body: { items: [] } }).set(
				INTERNAL_TOKEN_HEADER,
				'x'.repeat((ENV.INTERNAL_API_TOKEN as string).length)
			)
			last = res.status
		}

		expect(last).toBe(429)
	})
})
