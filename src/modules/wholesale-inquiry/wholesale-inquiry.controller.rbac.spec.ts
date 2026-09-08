import { INestApplication } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { WholesaleInquiryController } from './wholesale-inquiry.controller'
import { WholesaleInquiryService } from './wholesale-inquiry.service'

const INQUIRY_ID = '000000000000000000000001'

const resolved = () => jest.fn().mockResolvedValue({})

const wholesaleInquiryService = {
	create: resolved(),
	findAll: resolved(),
	updateStatus: resolved()
}

type AdminRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

/**
 * The inbox side of the wholesale form. `GET /wholesale-inquiries` is a list of leads with
 * names, phone numbers and company details, and the status write is what the manager works
 * through — both `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
 */
const ADMIN_ENDPOINTS: AdminRow[] = [
	['get', '/wholesale-inquiries', undefined, wholesaleInquiryService.findAll],
	['patch', `/wholesale-inquiries/${INQUIRY_ID}/status`, {}, wholesaleInquiryService.updateStatus]
]

/**
 * `POST /wholesale-inquiries` is a **write with no guard at all, on purpose**: it is the
 * "запросити оптову ціну" form on the storefront, and the visitor filling it in is by
 * definition not logged in. Guarding it would silently stop every wholesale lead from
 * reaching the shop — nothing would error, the form would just start answering 401 — so the
 * public case is asserted here as explicitly as the admin ones.
 */
describe('WholesaleInquiryController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [WholesaleInquiryController],
			providers: [{ provide: WholesaleInquiryService, useValue: wholesaleInquiryService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('the lead inbox is ADMIN-only', () => {
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

		/**
		 * `RolesGuard` reads `req.user.role`. Put first it answers before the token is validated:
		 * the anonymous caller would see 403 rather than 401, and the manager would see 403 too.
		 */
		it('answers 401, not 403, on the status write with no token — JwtAuthGuard goes first', async () => {
			const res = await send(app, 'patch', `/wholesale-inquiries/${INQUIRY_ID}/status`, {
				body: {}
			})

			expect(res.status).toBe(401)
		})
	})

	describe('the wholesale form stays public', () => {
		it('POST /wholesale-inquiries → 201 without a token', async () => {
			const res = await send(app, 'post', '/wholesale-inquiries', {
				body: { name: 'Оптовик', phone: '+380000000000' }
			})

			expect(res.status).toBe(201)
			expect(wholesaleInquiryService.create).toHaveBeenCalledTimes(1)
			expect(wholesaleInquiryService.create).toHaveBeenCalledWith({
				name: 'Оптовик',
				phone: '+380000000000'
			})
		})

		it('accepts the form from a logged-in USER as well, with no role check', async () => {
			const res = await send(app, 'post', '/wholesale-inquiries', {
				role: Role.USER,
				body: { name: 'Оптовик', phone: '+380000000000' }
			})

			expect(res.status).toBe(201)
			expect(wholesaleInquiryService.create).toHaveBeenCalledTimes(1)
		})

		/**
		 * SKIPPED — this is the behaviour the endpoint should have, not the behaviour it has.
		 *
		 * `POST /wholesale-inquiries` is the only unauthenticated write in the shop with no
		 * `ThrottlerGuard`: `POST /orders` is capped at 10/min, `POST /discount-coupons/validate`
		 * at 20/min, `POST /auth/login` at 10/min (API_AND_SWAGGER.md §4a), and this one is
		 * uncapped — a single client can insert `wholesale_inquiries` documents as fast as Mongo
		 * accepts them and bury the real leads in the admin inbox. The limit is not in the §4a
		 * table yet, so the value below is a proposal (10/min, matching the other public write
		 * that creates a document); enable this test together with the decorator and the table
		 * row. Owner of the fix: `wholesale-inquiry.controller.ts` (not owned by this spec).
		 */
		it('rate-limits the public form the way every other public write is limited', async () => {
			const LIMIT = 10
			const lead = { name: 'Оптовик', phone: '+380000000000' }
			const throttled = await createRbacApp({
				imports: [
					ThrottlerModule.forRoot({
						throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }],
						skipIf: isInternalRequest
					})
				],
				controllers: [WholesaleInquiryController],
				providers: [{ provide: WholesaleInquiryService, useValue: wholesaleInquiryService }]
			})

			try {
				for (let i = 0; i < LIMIT; i++) {
					const ok = await send(throttled, 'post', '/wholesale-inquiries', { body: lead })
					expect(ok.status).toBe(201)
				}

				const blocked = await send(throttled, 'post', '/wholesale-inquiries', {
					body: lead
				})

				expect(blocked.status).toBe(429)
				expect(blocked.headers['retry-after']).toBeDefined()
				expect(wholesaleInquiryService.create).toHaveBeenCalledTimes(LIMIT)
			} finally {
				await throttled.close()
			}
		})
	})
})
