import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { ColorController } from './color.controller'
import { ColorService } from './color.service'

const COLOR_ID = '000000000000000000000001'

const resolved = () => jest.fn().mockResolvedValue({})

const colorService = {
	findAll: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	delete: resolved()
}

type WriteRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

const WRITE_ENDPOINTS: WriteRow[] = [
	['post', '/colors', {}, colorService.create],
	['patch', `/colors/${COLOR_ID}`, {}, colorService.update],
	['delete', `/colors/${COLOR_ID}`, undefined, colorService.delete]
]

/** The dictionary is storefront data — swatches and colour names — with nothing to protect. */
const PUBLIC_GETS: [path: string, handler: jest.Mock][] = [
	['/colors', colorService.findAll],
	[`/colors/${COLOR_ID}`, colorService.findById]
]

describe('ColorController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [ColorController],
			providers: [{ provide: ColorService, useValue: colorService }]
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

	describe('read endpoints stay public', () => {
		it.each(PUBLIC_GETS)('GET %s → 200 without a token', async (path, handler) => {
			const res = await send(app, 'get', path)

			expect(res.status).toBe(200)
			expect(handler).toHaveBeenCalledTimes(1)
		})
	})
})
