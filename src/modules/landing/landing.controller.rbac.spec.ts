import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { LandingController } from './landing.controller'
import { LandingService } from './landing.service'

const LANDING_ID = '000000000000000000000001'

const resolved = () => jest.fn().mockResolvedValue({})

const landingService = {
	findActive: resolved(),
	findActiveSlugs: resolved(),
	findAllForAdmin: resolved(),
	findActiveBySlugs: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	delete: resolved()
}

type WriteRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

const WRITE_ENDPOINTS: WriteRow[] = [
	['post', '/landings', {}, landingService.create],
	['patch', `/landings/${LANDING_ID}`, {}, landingService.update],
	['delete', `/landings/${LANDING_ID}`, undefined, landingService.delete]
]

/**
 * Reading a landing by id, and listing every landing, both return drafts — unpublished copy
 * that must not be readable before it goes live.
 */
const ADMIN_GETS: [path: string, handler: jest.Mock][] = [
	['/landings/admin', landingService.findAllForAdmin],
	[`/landings/${LANDING_ID}`, landingService.findById]
]

const PUBLIC_GETS: [path: string, handler: jest.Mock][] = [
	['/landings', landingService.findActive],
	['/landings/slugs', landingService.findActiveSlugs],
	['/landings/slug/filament/pla-silk', landingService.findActiveBySlugs]
]

describe('LandingController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [LandingController],
			providers: [{ provide: LandingService, useValue: landingService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('write endpoints are ADMIN-only', () => {
		it.each(WRITE_ENDPOINTS)(
			'%s %s → 401 without a token',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { body })

				expect(res.status).toBe(401)
				expect(handler).not.toHaveBeenCalled()
			}
		)

		it.each(WRITE_ENDPOINTS)('%s %s → 403 for USER', async (method, path, body, handler) => {
			const res = await send(app, method, path, { role: Role.USER, body })

			expect(res.status).toBe(403)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(WRITE_ENDPOINTS)('%s %s → 2xx for ADMIN', async (method, path, body, handler) => {
			const res = await send(app, method, path, { role: Role.ADMIN, body })

			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			expect(handler).toHaveBeenCalledTimes(1)
		})
	})

	describe('draft-exposing reads are ADMIN-only', () => {
		it.each(ADMIN_GETS)('GET %s → 401 without a token', async (path, handler) => {
			const res = await send(app, 'get', path)

			expect(res.status).toBe(401)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_GETS)('GET %s → 403 for USER', async (path, handler) => {
			const res = await send(app, 'get', path, { role: Role.USER })

			expect(res.status).toBe(403)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_GETS)('GET %s → 200 for ADMIN', async (path, handler) => {
			const res = await send(app, 'get', path, { role: Role.ADMIN })

			expect(res.status).toBe(200)
			expect(handler).toHaveBeenCalledTimes(1)
		})
	})

	describe('published reads stay public', () => {
		it.each(PUBLIC_GETS)('GET %s → 200 without a token', async (path, handler) => {
			const res = await send(app, 'get', path)

			expect(res.status).toBe(200)
			expect(handler).toHaveBeenCalledTimes(1)
		})

		it('routes /landings/slugs to the slug listing, not to the :id handler', async () => {
			await send(app, 'get', '/landings/slugs')

			expect(landingService.findActiveSlugs).toHaveBeenCalledTimes(1)
			expect(landingService.findById).not.toHaveBeenCalled()
		})
	})
})
