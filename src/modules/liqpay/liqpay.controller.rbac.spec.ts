import {
	BadRequestException,
	ConflictException,
	INestApplication,
	ServiceUnavailableException
} from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { LiqpayController } from './liqpay.controller'
import { LiqpayService } from './liqpay.service'

// Importing LiqpayService for its DI token pulls in payment-provider.schema.ts, whose
// `@Prop({ enum: PaymentProvider })` lacks `type: String` and makes @nestjs/mongoose throw
// CannotDetermineTypeError under ts-jest — the same stub liqpay.service.spec.ts uses.
jest.mock('src/modules/payment-providers/payment-providers.service', () => ({
	PaymentProvidersService: class PaymentProvidersService {}
}))

const ORDER_NUMBER = 'FO-0000123'

/** What `LiqpayService.buildCheckout` returns; the browser form-POSTs these three fields. */
const CHECKOUT_PAYLOAD = {
	data: 'ZGF0YQ==',
	signature: 'c2lnbmF0dXJl',
	action_url: 'https://www.liqpay.ua/api/3/checkout'
}

/**
 * LiqPay posts exactly two form fields to `server_url` (LIQPAY_FLOW.md §4). Every body in this
 * spec is well-formed on purpose: `createRbacApp` registers no global `ValidationPipe`, so the
 * `400` that a missing `data`/`signature`, or an `order_number` outside `/^FO-\d{7}$/`, earns in
 * production (`main.ts`) cannot be observed from here — DTO validation is not covered by this file.
 */
const CALLBACK_BODY = { data: 'eyJvcmRlcl9pZCI6IkZPLTAwMDAxMjMifQ==', signature: 'c2ln' }

const liqpayService = {
	buildCheckout: jest.fn().mockResolvedValue(CHECKOUT_PAYLOAD),
	handleCallback: jest.fn().mockResolvedValue(undefined)
}

/**
 * `LiqpayController` carries **no** auth guard at all — not `JwtAuthGuard` (so the harness has
 * nothing to override here) and not `OptionalJwtAuthGuard` (so no passport stand-in is needed;
 * that guard lives only in `order.controller.ts` and `auth.controller.ts`). Both handlers must
 * therefore answer every caller, and the role is not the axis that matters: the rows below run
 * the same request anonymously, as a USER and as an ADMIN so that a guard of any shape added to
 * either route turns one of them red.
 */
const CALLERS: [label: string, role: string | undefined][] = [
	['a guest with no token', undefined],
	['a signed-in USER', Role.USER],
	['an ADMIN', Role.ADMIN]
]

/**
 * Every refusal `buildCheckout` documents (LIQPAY_FLOW.md §2) has to reach the buyer as itself:
 * the storefront branches on `code` and shows `message`. A handler that swallowed the rejection
 * — an added `.catch()`, a `try` around the call — answers `201` with an empty body instead, the
 * browser form-POSTs that empty payload to LiqPay, and the buyer is left reading a complaint
 * from the gateway rather than «Сторінку оплати вже відкрито». The `409` is the costliest of the
 * three to lose: it is the one-live-session guard that keeps a second tab from charging twice.
 */
const REFUSALS: [label: string, error: Error, status: number, body: object][] = [
	[
		'a session is already live on the order',
		new ConflictException({
			statusCode: 409,
			error: 'Conflict',
			code: 'LIQPAY_SESSION_ACTIVE',
			message:
				'Сторінку оплати вже відкрито. Якщо платіж не завершено, спробуйте ще раз трохи пізніше або оберіть інший спосіб оплати',
			retry_after_seconds: 812
		}),
		409,
		{ code: 'LIQPAY_SESSION_ACTIVE', retry_after_seconds: 812 }
	],
	[
		'the gateway credentials cannot be read',
		new ServiceUnavailableException({
			statusCode: 503,
			error: 'Service Unavailable',
			code: 'LIQPAY_UNAVAILABLE',
			message:
				'Оплату карткою не розпочато — сервіс оплати тимчасово недоступний. Кошти не списано: спробуйте ще раз за кілька хвилин або оберіть інший спосіб оплати'
		}),
		503,
		{ code: 'LIQPAY_UNAVAILABLE' }
	],
	[
		'the order is paid already',
		new BadRequestException('Замовлення вже оплачено'),
		400,
		{ message: 'Замовлення вже оплачено' }
	]
]

describe('LiqpayController RBAC — both endpoints are deliberately public', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [LiqpayController],
			providers: [{ provide: LiqpayService, useValue: liqpayService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	/**
	 * Guest checkout is a supported flow: `POST /orders` uses `OptionalJwtAuthGuard` precisely so
	 * a buyer without an account can order, and this is the next step of that same flow. A guard
	 * added here kills card payment for everyone who did not register, and the failure reads as
	 * «LiqPay не працює» rather than as an auth change — nothing in the logs says «401».
	 */
	describe('POST /liqpay/checkout', () => {
		it.each(CALLERS)('hands %s the signed payload', async (_label, role) => {
			const res = await send(app, 'post', '/liqpay/checkout', {
				role,
				body: { order_number: ORDER_NUMBER }
			})

			expect(res.status).toBe(201)
			expect(res.body).toEqual(CHECKOUT_PAYLOAD)
			expect(liqpayService.buildCheckout).toHaveBeenCalledTimes(1)
		})

		/** The order number is the only thing LiqPay matches the callback back to (`order_id`). */
		it('passes the order number, not the whole DTO, to the service', async () => {
			await send(app, 'post', '/liqpay/checkout', {
				body: { order_number: ORDER_NUMBER }
			})

			expect(liqpayService.buildCheckout).toHaveBeenCalledWith(ORDER_NUMBER)
		})

		it.each(REFUSALS)(
			'answers as the service refused when %s',
			async (_label, error, status, body) => {
				liqpayService.buildCheckout.mockRejectedValueOnce(error)

				const res = await send(app, 'post', '/liqpay/checkout', {
					body: { order_number: ORDER_NUMBER }
				})

				expect(res.status).toBe(status)
				expect(res.body).toMatchObject(body)
			}
		)
	})

	/**
	 * LiqPay's servers call this route, so there is no session, no cookie and no token to present.
	 * Its authenticity comes from the HMAC signature verified inside `LiqpayService.handleCallback`
	 * (`verifyLiqpaySignature`, constant-time — see LIQPAY_FLOW.md §4 step 2), never from a guard.
	 * "Securing" it with `JwtAuthGuard` would not make it safer; it would silently stop every
	 * payment confirmation, leaving paid orders stuck on `PENDING` forever.
	 */
	describe('POST /liqpay/callback', () => {
		it.each(CALLERS)('accepts the callback posted as %s', async (_label, role) => {
			const res = await send(app, 'post', '/liqpay/callback', { role, body: CALLBACK_BODY })

			expect(res.status).toBe(200)
			expect(liqpayService.handleCallback).toHaveBeenCalledTimes(1)
		})

		/**
		 * `@HttpCode(200)` is load-bearing, not cosmetic: LiqPay retries a callback it did not get
		 * a 200 for, so Nest's default 201 for a POST turns every confirmation into a stream of
		 * duplicate callbacks against the order.
		 */
		it('answers exactly 200 with { status: "ok" }', async () => {
			const res = await send(app, 'post', '/liqpay/callback', { body: CALLBACK_BODY })

			expect(res.status).toBe(200)
			expect(res.body).toEqual({ status: 'ok' })
		})

		/** The signature must reach the verifier; a handler that drops it authenticates nothing. */
		it('hands the payload and its signature to the service for verification', async () => {
			await send(app, 'post', '/liqpay/callback', { body: CALLBACK_BODY })

			expect(liqpayService.handleCallback).toHaveBeenCalledWith(
				CALLBACK_BODY.data,
				CALLBACK_BODY.signature
			)
		})

		/**
		 * The `await` in front of `handleCallback` is what makes that 200 a promise kept. LiqPay
		 * reads any 2xx as «confirmation delivered» and never sends it again, so the one step the
		 * service does not swallow — `applyGatewayPaymentResult` (`liqpay.service.ts:214`), i.e. the
		 * database write that marks the order PAID — must be able to make this endpoint answer
		 * non-2xx and buy a retry. Answer the gateway before applying the result (fire-and-forget,
		 * or a `.catch()` that hides the failure) and a paid order stays PENDING forever, with the
		 * confirmation LiqPay would have re-sent thrown away.
		 */
		it('answers non-2xx when applying the result fails, so LiqPay retries', async () => {
			liqpayService.handleCallback.mockRejectedValueOnce(new Error('Mongo unreachable'))

			const res = await send(app, 'post', '/liqpay/callback', { body: CALLBACK_BODY })

			expect(res.status).toBe(500)
		})
	})
})

/**
 * `POST /liqpay/checkout` is unauthenticated and every accepted request opens a payment session
 * on an order, so `@Throttle` is the only thing between the gateway and a flood of sessions. The
 * limit is the handler's own decorator and the row in `src/docs/API_AND_SWAGGER.md` §4a — raising
 * one without the other fails here.
 */
describe('LiqpayController — rate limiting', () => {
	let app: INestApplication

	const CHECKOUT_LIMIT = 10
	const MODULE_DEFAULT = 20

	beforeEach(async () => {
		jest.clearAllMocks()
		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: MODULE_DEFAULT }],
					skipIf: isInternalRequest
				})
			],
			controllers: [LiqpayController],
			providers: [{ provide: LiqpayService, useValue: liqpayService }]
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it(`opens ${CHECKOUT_LIMIT} checkouts a minute from one IP, then answers 429 for the rest of it`, async () => {
		for (let i = 0; i < CHECKOUT_LIMIT; i++) {
			const ok = await send(app, 'post', '/liqpay/checkout', {
				body: { order_number: ORDER_NUMBER }
			})
			expect(ok.status).toBe(201)
		}

		const blocked = await send(app, 'post', '/liqpay/checkout', {
			body: { order_number: ORDER_NUMBER }
		})

		expect(blocked.status).toBe(429)
		// `Retry-After` is the window itself, in seconds (`blockDuration` defaults to `ttl`), and it
		// is the only trace of the ttl a caller can observe. Counting the ten requests alone would
		// let the @nestjs/throttler v4→v5 units trap through: `ttl: 60_000` mistyped as `ttl: 60` is
		// a 60-millisecond window — 600 payment sessions a minute per IP — and still 429s the 11th
		// request in a test that fires them back to back.
		expect(Number(blocked.headers['retry-after'])).toBe(60)
		expect(liqpayService.buildCheckout).toHaveBeenCalledTimes(CHECKOUT_LIMIT)
	})

	/**
	 * The callback carries no limit on purpose, and it must stay that way: LiqPay retries what it
	 * cannot deliver, so a 429 to the gateway either loses the confirmation or multiplies the
	 * retries. It is not a flood risk either — an unsigned payload is dropped inside the service.
	 * The loop deliberately runs past the module-wide default, which is what a bare
	 * `@UseGuards(ThrottlerGuard)` on this handler would inherit.
	 */
	it('never rate-limits the gateway callback', async () => {
		for (let i = 0; i <= MODULE_DEFAULT; i++) {
			const res = await send(app, 'post', '/liqpay/callback', { body: CALLBACK_BODY })
			expect(res.status).toBe(200)
		}

		expect(liqpayService.handleCallback).toHaveBeenCalledTimes(MODULE_DEFAULT + 1)
	})
})
