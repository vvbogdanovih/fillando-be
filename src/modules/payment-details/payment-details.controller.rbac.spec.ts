import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { PaymentDetailsController } from './payment-details.controller'
import { PaymentDetailsService } from './payment-details.service'

const PAYMENT_DETAILS_ID = '000000000000000000000001'

const resolved = () => jest.fn().mockResolvedValue({})

const paymentDetailsService = {
	findAll: resolved(),
	findActive: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	delete: resolved(),
	activate: resolved()
}

type AdminRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

/**
 * Every handler of the controller — the module has no public route, reads included.
 *
 * These are the shop's own bank details: the IBAN a buyer is asked to transfer money to. A read
 * that anyone can call is a read an attacker can watch, and swapping the account number is the
 * whole point of attacking this collection — so the writes and the three reads share one guard
 * chain, `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
 *
 * `GET /payment-details/active` is the row to watch: the frontend's route constant still
 * describes it as "public active record", and nothing in the storefront calls it. Whoever wires
 * the buyer-facing bank-transfer screen must add a **projected** public endpoint instead of
 * dropping the guard from this one, which returns the raw document.
 */
const ADMIN_ENDPOINTS: AdminRow[] = [
	['get', '/payment-details', undefined, paymentDetailsService.findAll],
	['get', '/payment-details/active', undefined, paymentDetailsService.findActive],
	['get', `/payment-details/${PAYMENT_DETAILS_ID}`, undefined, paymentDetailsService.findById],
	['post', '/payment-details', {}, paymentDetailsService.create],
	['patch', `/payment-details/${PAYMENT_DETAILS_ID}`, {}, paymentDetailsService.update],
	['delete', `/payment-details/${PAYMENT_DETAILS_ID}`, undefined, paymentDetailsService.delete],
	[
		'patch',
		`/payment-details/${PAYMENT_DETAILS_ID}/activate`,
		undefined,
		paymentDetailsService.activate
	]
]

describe('PaymentDetailsController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [PaymentDetailsController],
			providers: [{ provide: PaymentDetailsService, useValue: paymentDetailsService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('every endpoint is ADMIN-only (writes + the bank details themselves)', () => {
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
			await send(app, 'patch', `/payment-details/${PAYMENT_DETAILS_ID}`, {
				role: Role.ADMIN,
				body: { iban: 'UA000000000000000000000000000' }
			})

			expect(paymentDetailsService.update).toHaveBeenCalledTimes(1)
			expect(paymentDetailsService.update).toHaveBeenCalledWith(PAYMENT_DETAILS_ID, {
				iban: 'UA000000000000000000000000000'
			})
		})
	})

	/**
	 * `RolesGuard` reads `req.user.role`, so it has to run second. Listed first it would answer
	 * before the token is validated: 403 for the anonymous caller (instead of 401) and 403 for
	 * the ADMIN too, which is the half that takes the IBAN screen down.
	 */
	describe('JwtAuthGuard runs before RolesGuard', () => {
		it('answers 401, not 403, when the activate call carries no token', async () => {
			const res = await send(app, 'patch', `/payment-details/${PAYMENT_DETAILS_ID}/activate`)

			expect(res.status).toBe(401)
		})

		it('lets an ADMIN activate a record, which a RolesGuard-first chain never would', async () => {
			const res = await send(
				app,
				'patch',
				`/payment-details/${PAYMENT_DETAILS_ID}/activate`,
				{
					role: Role.ADMIN
				}
			)

			expect(res.status).toBe(200)
			expect(paymentDetailsService.activate).toHaveBeenCalledWith(PAYMENT_DETAILS_ID)
		})
	})

	/** '/active' is declared before '/:id'; the reverse order turns it into an id lookup. */
	it("resolves '/payment-details/active' to findActive and not to the ':id' route", async () => {
		await send(app, 'get', '/payment-details/active', { role: Role.ADMIN })

		expect(paymentDetailsService.findActive).toHaveBeenCalledTimes(1)
		expect(paymentDetailsService.findById).not.toHaveBeenCalled()
	})
})
