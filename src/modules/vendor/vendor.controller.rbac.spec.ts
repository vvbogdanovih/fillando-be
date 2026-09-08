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

type AdminRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

/**
 * Every handler of the controller — the module has no public route left.
 *
 * A `Vendor` IS a supplier, so the reads are admin-only for the same reason as the writes: the
 * list, a single record and the availability probe (which confirms whether a supplier name or
 * slug is taken) are all supplier data. Only the admin UI calls them; the storefront never
 * mentions a vendor.
 */
const ADMIN_ENDPOINTS: AdminRow[] = [
	['get', '/vendors', undefined, vendorService.findAll],
	['get', '/vendors/check-availability', undefined, vendorService.checkAvailability],
	['get', `/vendors/${VENDOR_ID}`, undefined, vendorService.findById],
	['post', '/vendors', {}, vendorService.create],
	['patch', `/vendors/${VENDOR_ID}`, {}, vendorService.update],
	['delete', `/vendors/${VENDOR_ID}`, undefined, vendorService.delete]
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

	describe('every endpoint is ADMIN-only (writes + supplier reads)', () => {
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
			await send(app, 'post', '/vendors', { role: Role.ADMIN, body: { name: 'Acme' } })

			expect(vendorService.create).toHaveBeenCalledTimes(1)
			expect(vendorService.create).toHaveBeenCalledWith({ name: 'Acme' })
		})
	})
})
