import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { VendorController } from './vendor.controller'
import { VendorService } from './vendor.service'

const VENDOR_ID = '000000000000000000000001'

const resolved = () => jest.fn().mockResolvedValue({})

const vendorService = {
	findAll: resolved(),
	checkAvailability: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	delete: resolved()
}

type WriteRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

const WRITE_ENDPOINTS: WriteRow[] = [
	['post', '/vendors', {}, vendorService.create],
	['patch', `/vendors/${VENDOR_ID}`, {}, vendorService.update],
	['delete', `/vendors/${VENDOR_ID}`, undefined, vendorService.delete]
]

const PUBLIC_GETS: [path: string, handler: jest.Mock][] = [
	['/vendors', vendorService.findAll],
	['/vendors/check-availability', vendorService.checkAvailability],
	[`/vendors/${VENDOR_ID}`, vendorService.findById]
]

describe('VendorController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [VendorController],
			providers: [{ provide: VendorService, useValue: vendorService }]
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

		it('passes control through the guard chain to the service exactly once for ADMIN', async () => {
			await send(app, 'post', '/vendors', { role: Role.ADMIN, body: { name: 'Acme' } })

			expect(vendorService.create).toHaveBeenCalledTimes(1)
			expect(vendorService.create).toHaveBeenCalledWith({ name: 'Acme' })
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
