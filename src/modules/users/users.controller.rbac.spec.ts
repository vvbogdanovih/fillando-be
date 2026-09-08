import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

const resolved = () => jest.fn().mockResolvedValue({})

const usersService = {
	findAll: resolved(),
	getMe: resolved(),
	updateMe: resolved()
}

/**
 * `GET /users` is the customer list — names, emails, phones and order counts of every buyer.
 * It is the only ADMIN-guarded route of the module (`@UseGuards(JwtAuthGuard, RolesGuard)` +
 * `@Roles(Role.ADMIN)` on the handler, on top of the class-level `JwtAuthGuard`).
 */
type OwnRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

/**
 * The self-service pair. `PATCH /users/me` is a **write** that is deliberately NOT admin-only:
 * it is how a buyer edits their own name, phone and delivery defaults, and the service scopes
 * every query by `req.user.id`. Adding `RolesGuard` + `@Roles(Role.ADMIN)` here — the reflex
 * when someone sweeps the controllers looking for unguarded writes — locks every customer out
 * of their own profile, so both rows assert that a plain USER still gets through.
 */
const OWN_PROFILE_ENDPOINTS: OwnRow[] = [
	['get', '/users/me', undefined, usersService.getMe],
	['patch', '/users/me', {}, usersService.updateMe]
]

describe('UsersController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [UsersController],
			providers: [{ provide: UsersService, useValue: usersService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('the customer list is ADMIN-only', () => {
		it('GET /users → 401 without a token', async () => {
			const res = await send(app, 'get', '/users')

			expect(res.status).toBe(401)
			expect(usersService.findAll).not.toHaveBeenCalled()
		})

		it('GET /users → 403 for USER', async () => {
			const res = await send(app, 'get', '/users', { role: Role.USER })

			expect(res.status).toBe(403)
			expect(usersService.findAll).not.toHaveBeenCalled()
		})

		it('GET /users → 200 for ADMIN', async () => {
			const res = await send(app, 'get', '/users', { role: Role.ADMIN })

			expect(res.status).toBe(200)
			expect(usersService.findAll).toHaveBeenCalledTimes(1)
		})

		/**
		 * With `RolesGuard` listed before `JwtAuthGuard` the anonymous case would answer 403 and
		 * the ADMIN case would answer 403 as well — the pair above is what separates the two
		 * orders. This asserts the anonymous half explicitly, since 401 is the observable proof
		 * that the token check ran first.
		 */
		it('answers 401, not 403, when no token is present at all', async () => {
			const res = await send(app, 'get', '/users')

			expect(res.status).toBe(401)
		})
	})

	describe('own-profile endpoints need a token but no role', () => {
		it.each(OWN_PROFILE_ENDPOINTS)(
			'%s %s → 401 without a token',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { body })

				expect(res.status).toBe(401)
				expect(handler).not.toHaveBeenCalled()
			}
		)

		it.each(OWN_PROFILE_ENDPOINTS)(
			'%s %s → 200 for a plain USER',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { role: Role.USER, body })

				expect(res.status).toBe(200)
				expect(handler).toHaveBeenCalledTimes(1)
			}
		)

		it.each(OWN_PROFILE_ENDPOINTS)(
			'%s %s → 200 for ADMIN as well',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { role: Role.ADMIN, body })

				expect(res.status).toBe(200)
				expect(handler).toHaveBeenCalledTimes(1)
			}
		)

		/**
		 * The service is the only thing that decides *whose* profile is written, and it can only
		 * do that if the guard chain hands it the caller. This pins that the identity reaches the
		 * service rather than the body.
		 */
		it('passes the authenticated caller, not the body, to updateMe', async () => {
			await send(app, 'patch', '/users/me', {
				role: Role.USER,
				body: { name: 'Новий', id: 'someone-else' }
			})

			expect(usersService.updateMe).toHaveBeenCalledTimes(1)
			expect(usersService.updateMe).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'u1', role: Role.USER }),
				{ name: 'Новий', id: 'someone-else' }
			)
		})
	})

	/** No handler in this module is public — the class-level `JwtAuthGuard` covers all three. */
	it('leaves no route of the module open to an anonymous caller', async () => {
		const statuses = await Promise.all([
			send(app, 'get', '/users').then(r => r.status),
			send(app, 'get', '/users/me').then(r => r.status),
			send(app, 'patch', '/users/me', { body: {} }).then(r => r.status)
		])

		expect(statuses).toEqual([401, 401, 401])
	})
})
