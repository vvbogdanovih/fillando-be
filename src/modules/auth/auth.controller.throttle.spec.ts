import { INestApplication, UnauthorizedException } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { PinoLogger } from 'nestjs-pino'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from 'src/common/guards/internal-request.util'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'

/**
 * The rate limit on `POST /auth/login` is the only thing between this shop and an offline-speed
 * password guess: there is no lockout, no captcha and no second factor, so a caller who may
 * post credentials as fast as Nest can hash them owns every account with a weak password. The
 * limits below are the handlers' own `@Throttle` values and the table in
 * `src/docs/API_AND_SWAGGER.md` §4a — a handler's `@Throttle` overrides the module default, so
 * these numbers are what the endpoints really enforce, and raising one in the controller without
 * raising it here fails.
 *
 * Auth endpoints with **no** limit, deliberately: `POST /auth/logout` (clears two cookies, needs
 * no secret) and `GET /auth/me` (`OptionalJwtAuthGuard`, reads only the caller's own token).
 */
const LIMITS = {
	login: 10,
	register: 10,
	refresh: 30
}

const CREDENTIALS = { email: 'buyer@example.invalid', password: 'correct horse battery' }

describe('AuthController — rate limiting on the credential endpoints', () => {
	let app: INestApplication
	let authService: {
		login: jest.Mock
		register: jest.Mock
		refresh: jest.Mock
		googleLogin: jest.Mock
		logout: jest.Mock
		getMe: jest.Mock
	}

	const tokens = { access_token: 'access', refresh_token: 'refresh', user: { id: 'u1' } }

	beforeEach(async () => {
		authService = {
			login: jest.fn().mockResolvedValue(tokens),
			register: jest.fn().mockResolvedValue(tokens),
			refresh: jest.fn().mockResolvedValue(tokens),
			googleLogin: jest.fn().mockResolvedValue(tokens),
			logout: jest.fn().mockResolvedValue(undefined),
			getMe: jest.fn().mockResolvedValue({ id: 'u1' })
		}

		app = await createRbacApp({
			imports: [
				ThrottlerModule.forRoot({
					throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
					skipIf: isInternalRequest
				})
			],
			controllers: [AuthController],
			providers: [
				{ provide: AuthService, useValue: authService },
				{
					provide: PinoLogger,
					useValue: { setContext() {}, info() {}, warn() {}, error() {}, debug() {} }
				}
			]
		})
	})

	afterEach(async () => {
		await app.close()
	})

	describe('POST /auth/login', () => {
		it(`accepts ${LIMITS.login} attempts a minute, then answers 429 with Retry-After`, async () => {
			for (let i = 0; i < LIMITS.login; i++) {
				const ok = await send(app, 'post', '/auth/login', { body: CREDENTIALS })
				expect(ok.status).toBe(201)
			}

			const blocked = await send(app, 'post', '/auth/login', { body: CREDENTIALS })

			expect(blocked.status).toBe(429)
			expect(blocked.headers['retry-after']).toBeDefined()
			expect(authService.login).toHaveBeenCalledTimes(LIMITS.login)
		})

		/**
		 * The property that actually stops a brute force: a **wrong** password costs the caller
		 * one of their ten attempts. `ThrottlerGuard` runs before the handler, so the counter does
		 * not care whether the credentials verified — move the limit behind the password check and
		 * a guesser gets unlimited tries while this test goes red.
		 */
		it('counts failed attempts too, and stops calling the service once the limit is spent', async () => {
			authService.login.mockRejectedValue(new UnauthorizedException())

			for (let i = 0; i < LIMITS.login; i++) {
				const rejected = await send(app, 'post', '/auth/login', {
					body: { ...CREDENTIALS, password: `guess-${i}` }
				})
				expect(rejected.status).toBe(401)
			}

			const blocked = await send(app, 'post', '/auth/login', {
				body: { ...CREDENTIALS, password: 'guess-10' }
			})

			expect(blocked.status).toBe(429)
			expect(authService.login).toHaveBeenCalledTimes(LIMITS.login)
		})
	})

	describe('POST /auth/register', () => {
		it(`accepts ${LIMITS.register} registrations a minute, then answers 429`, async () => {
			for (let i = 0; i < LIMITS.register; i++) {
				const ok = await send(app, 'post', '/auth/register', {
					body: { ...CREDENTIALS, name: `Buyer ${i}` }
				})
				expect(ok.status).toBe(201)
			}

			const blocked = await send(app, 'post', '/auth/register', {
				body: { ...CREDENTIALS, name: 'Buyer 10' }
			})

			expect(blocked.status).toBe(429)
			expect(blocked.headers['retry-after']).toBeDefined()
			expect(authService.register).toHaveBeenCalledTimes(LIMITS.register)
		})
	})

	/**
	 * The refresh cookie is a long-lived credential, and this endpoint mints a fresh access token
	 * from it. Its limit is looser than login's (30/min) because an open tab refreshes on a timer,
	 * but it is not absent: without it a stolen refresh token can be replayed in a loop.
	 */
	describe('POST /auth/refresh', () => {
		it(`serves ${LIMITS.refresh} refreshes a minute, then answers 429`, async () => {
			for (let i = 0; i < LIMITS.refresh; i++) {
				const ok = await send(app, 'post', '/auth/refresh', { body: {} })
				expect(ok.status).toBe(201)
			}

			const blocked = await send(app, 'post', '/auth/refresh', { body: {} })

			expect(blocked.status).toBe(429)
			expect(blocked.headers['retry-after']).toBeDefined()
			expect(authService.refresh).toHaveBeenCalledTimes(LIMITS.refresh)
		})
	})

	/** One shared counter would let a login flood lock legitimate visitors out of registering. */
	it('counts the limits per endpoint, not per controller', async () => {
		for (let i = 0; i < LIMITS.login + 1; i++) {
			await send(app, 'post', '/auth/login', { body: CREDENTIALS })
		}

		const register = await send(app, 'post', '/auth/register', {
			body: { ...CREDENTIALS, name: 'Buyer' }
		})

		expect(register.status).toBe(201)
	})

	/**
	 * `INTERNAL_API_TOKEN` exempts our own server-side fetches from every limit
	 * (`skipIf` → `isInternalRequest`). The comparison is constant-time and length-checked, so a
	 * caller who guesses the header's shape but not its value keeps the login limit — otherwise
	 * the bypass would be the brute-force path itself.
	 */
	it('gives a wrong internal token no exemption on login', async () => {
		const wrong = 'x'.repeat((ENV.INTERNAL_API_TOKEN as string).length)
		let last = 0

		for (let i = 0; i < LIMITS.login + 1; i++) {
			const res = await send(app, 'post', '/auth/login', { body: CREDENTIALS }).set(
				INTERNAL_TOKEN_HEADER,
				wrong
			)
			last = res.status
		}

		expect(last).toBe(429)
	})

	/**
	 * Password recovery does not exist in this backend yet — there is no `/auth/forgot-password`
	 * and no `/auth/reset-password` handler to guard. A recovery flow is a credential endpoint
	 * like the two above (an email enumeration probe on the request side, a token guess on the
	 * confirm side), so it arrives with `@UseGuards(ThrottlerGuard)`, a `@Throttle` value, a row
	 * in `API_AND_SWAGGER.md` §4a and a case here.
	 */
	it.todo('caps password recovery once /auth/forgot-password and /auth/reset-password exist')
})
