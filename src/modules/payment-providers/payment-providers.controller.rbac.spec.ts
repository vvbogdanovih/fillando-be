import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { PaymentProvider, Role } from 'src/common/types/enums'
import { PaymentProvidersController } from './payment-providers.controller'
import { PaymentProvidersService } from './payment-providers.service'

const PROVIDER_ID = '000000000000000000000001'
const CREATE_BODY = { provider: PaymentProvider.MONOPAY, public_key: 'sandbox_i0000000000' }
const UPDATE_BODY = { public_key: 'sandbox_i1111111111' }

const resolved = () => jest.fn().mockResolvedValue({})

const paymentProvidersService = {
	findAll: resolved(),
	findActiveByProvider: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	delete: resolved(),
	activate: resolved()
}

type AdminRow = [
	method: HttpMethod,
	path: string,
	body: object | undefined,
	handler: jest.Mock,
	/** Arguments the service call must receive — a row whose id or body is dropped on the way
	 * through would otherwise still register as one call and pass. */
	args: unknown[]
]

/**
 * Every handler behind `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
 *
 * This collection holds the shop's own payment credentials — the LiqPay/MonoPay keys the
 * service signs charges with. The reads are admin-only along with the writes: the service masks
 * `private_key_enc`, but `public_key`, `label` and `sandbox` still identify the merchant account,
 * and a write here redirects buyers' money to someone else's keys. A guard falling off any of
 * these rows is a credential leak, not a cosmetic regression.
 */
const ADMIN_ENDPOINTS: AdminRow[] = [
	['get', '/payment-providers', undefined, paymentProvidersService.findAll, []],
	[
		'get',
		`/payment-providers/${PROVIDER_ID}`,
		undefined,
		paymentProvidersService.findById,
		[PROVIDER_ID]
	],
	['post', '/payment-providers', CREATE_BODY, paymentProvidersService.create, [CREATE_BODY]],
	[
		'patch',
		`/payment-providers/${PROVIDER_ID}`,
		UPDATE_BODY,
		paymentProvidersService.update,
		[PROVIDER_ID, UPDATE_BODY]
	],
	[
		'delete',
		`/payment-providers/${PROVIDER_ID}`,
		undefined,
		paymentProvidersService.delete,
		[PROVIDER_ID]
	],
	[
		'patch',
		`/payment-providers/${PROVIDER_ID}/activate`,
		undefined,
		paymentProvidersService.activate,
		[PROVIDER_ID]
	]
]

/**
 * The two live providers, both driven through the public route. Hardcoding one of them would make
 * 'forwards the path param' and 'always asks about LIQPAY' indistinguishable — and with the param
 * ignored, checkout asking whether MonoPay is switched on gets LiqPay's answer and offers or
 * hides the wrong payment method.
 */
const PROVIDERS = Object.values(PaymentProvider)

const activePath = (provider: string) => `/payment-providers/active/${provider}`

describe('PaymentProvidersController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [PaymentProvidersController],
			providers: [{ provide: PaymentProvidersService, useValue: paymentProvidersService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('credential management is ADMIN-only (writes + reads)', () => {
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

		/**
		 * The row that catches a dropped `@Roles(Role.ADMIN)`: `RolesGuard` is default-deny, so
		 * without the decorator every caller gets 403 and the 401/USER rows above stay green.
		 */
		it.each(ADMIN_ENDPOINTS)(
			'%s %s → 2xx for ADMIN, with the id and body it was called with',
			async (method, path, body, handler, args) => {
				const res = await send(app, method, path, { role: Role.ADMIN, body })

				expect(res.status).toBeGreaterThanOrEqual(200)
				expect(res.status).toBeLessThan(300)
				expect(handler).toHaveBeenCalledTimes(1)
				expect(handler).toHaveBeenCalledWith(...args)
			}
		)

		it('passes control through the guard chain to the service exactly once for ADMIN', async () => {
			await send(app, 'patch', `/payment-providers/${PROVIDER_ID}`, {
				role: Role.ADMIN,
				body: { public_key: 'sandbox_i0000000000' }
			})

			expect(paymentProvidersService.update).toHaveBeenCalledTimes(1)
			expect(paymentProvidersService.update).toHaveBeenCalledWith(PROVIDER_ID, {
				public_key: 'sandbox_i0000000000'
			})
		})
	})

	/**
	 * `RolesGuard` reads `req.user.role`, so it has to run second. Listed first it would answer
	 * before the token is validated: 403 for the anonymous caller (instead of 401) and 403 for the
	 * ADMIN too — and the admin screen can then no longer rotate a leaked key.
	 */
	describe('JwtAuthGuard runs before RolesGuard', () => {
		it('answers 401, not 403, when the activate call carries no token', async () => {
			const res = await send(app, 'patch', `/payment-providers/${PROVIDER_ID}/activate`)

			expect(res.status).toBe(401)
		})

		it('lets an ADMIN activate a provider, which a RolesGuard-first chain never would', async () => {
			const res = await send(app, 'patch', `/payment-providers/${PROVIDER_ID}/activate`, {
				role: Role.ADMIN
			})

			expect(res.status).toBe(200)
			expect(paymentProvidersService.activate).toHaveBeenCalledWith(PROVIDER_ID)
		})
	})

	/**
	 * The checkout page asks whether a provider is switched on before it offers card payment, so
	 * this route carries no guard at all. A guard added here fails silently — the storefront just
	 * starts getting 401 and the payment option disappears with nothing in the logs.
	 */
	describe('GET /active/:provider stays public for checkout', () => {
		it.each(PROVIDERS)('answers 200 for %s without a token', async provider => {
			const res = await send(app, 'get', activePath(provider))

			expect(res.status).toBe(200)
			expect(paymentProvidersService.findActiveByProvider).toHaveBeenCalledWith(provider)
		})

		it.each(PROVIDERS)('answers 200 for %s for a signed-in USER as well', async provider => {
			const res = await send(app, 'get', activePath(provider), { role: Role.USER })

			expect(res.status).toBe(200)
			expect(paymentProvidersService.findActiveByProvider).toHaveBeenCalledWith(provider)
		})

		/**
		 * `new ParseEnumPipe(PaymentProvider)` is what keeps an unknown provider name from reaching
		 * the service as a raw string: without it checkout gets 200 and `null` for a typo, which
		 * reads as 'provider switched off' instead of 'no such provider'.
		 */
		it('answers 400 for a provider outside the enum', async () => {
			const res = await send(app, 'get', activePath('PAYPAL'))

			expect(res.status).toBe(400)
			expect(paymentProvidersService.findActiveByProvider).not.toHaveBeenCalled()
		})
	})

	/**
	 * `/active/:provider` and the admin `/:id` read share this controller. The public route must
	 * resolve to the masked active-provider lookup, never to the id read that returns the stored
	 * credential document.
	 */
	it.each(PROVIDERS)(
		"resolves /active/%s to findActiveByProvider and not to the ':id' route",
		async provider => {
			await send(app, 'get', activePath(provider))

			expect(paymentProvidersService.findActiveByProvider).toHaveBeenCalledTimes(1)
			expect(paymentProvidersService.findById).not.toHaveBeenCalled()
		}
	)
})
