import { INestApplication, UnauthorizedException } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import cookieParser from 'cookie-parser'
import { ENV } from 'src/common/constants'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'

/**
 * A rejected `POST /auth/refresh` must clear both cookies itself. The storefront no longer calls
 * `POST /auth/logout` when a refresh fails: that call carried whatever refresh cookie the jar
 * held at the moment — in a two-tab race, the other tab's freshly rotated token — and revoked
 * it for every tab. A success must leave the jar alone except for the two new values.
 */
const clearedCookies = (res: { headers: Record<string, string | string[] | undefined> }) => {
	const raw = res.headers['set-cookie']
	const list = Array.isArray(raw) ? raw : raw ? [raw] : []
	return list.filter(c => /Expires=Thu, 01 Jan 1970/.test(c)).map(c => c.split('=')[0])
}

describe('POST /auth/refresh — cookies on rejection', () => {
	let app: INestApplication
	let refresh: jest.Mock

	beforeEach(async () => {
		refresh = jest.fn()
		app = await createRbacApp({
			controllers: [AuthController],
			providers: [
				{ provide: AuthService, useValue: { refresh } },
				{
					provide: PinoLogger,
					useValue: { setContext() {}, info() {}, warn() {}, error() {}, debug() {} }
				}
			]
		})
		app.use(cookieParser())
	})

	afterEach(async () => {
		await app.close()
	})

	it('clears both cookies when the service rejects the token', async () => {
		refresh.mockRejectedValue(new UnauthorizedException('Refresh token вже використано.'))

		const res = await send(app, 'post', '/auth/refresh', { body: {} })

		expect(res.status).toBe(401)
		expect(clearedCookies(res).sort()).toEqual(
			[ENV.ACCSESS_TOKEN_NAME, ENV.REFRESH_TOKEN_NAME].sort()
		)
	})

	it('sets the new pair and clears nothing on success', async () => {
		refresh.mockResolvedValue({ access_token: 'a2', refresh_token: 'r2' })

		const res = await send(app, 'post', '/auth/refresh', { body: {} })

		expect(res.status).toBe(201)
		expect(clearedCookies(res)).toEqual([])
		const raw = res.headers['set-cookie'] as string[]
		expect(raw.some(c => c.startsWith(`${ENV.ACCSESS_TOKEN_NAME}=a2`))).toBe(true)
		expect(raw.some(c => c.startsWith(`${ENV.REFRESH_TOKEN_NAME}=r2`))).toBe(true)
	})

	it('does not clear cookies on an unexpected error (the session may still be fine)', async () => {
		refresh.mockRejectedValue(new Error('db down'))

		const res = await send(app, 'post', '/auth/refresh', { body: {} })

		expect(res.status).toBe(500)
		expect(clearedCookies(res)).toEqual([])
	})
})
