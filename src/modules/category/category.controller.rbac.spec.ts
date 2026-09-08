import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { CategoryController } from './category.controller'
import { CategoryService } from './category.service'

const CATEGORY_ID = '000000000000000000000001'

const resolved = () => jest.fn().mockResolvedValue({})

const categoryService = {
	findAll: resolved(),
	findBySlug: resolved(),
	findById: resolved(),
	create: resolved(),
	update: resolved(),
	replace: resolved(),
	delete: resolved()
}

type WriteRow = [method: HttpMethod, path: string, body: object | undefined, handler: jest.Mock]

/**
 * The taxonomy is what the whole catalogue hangs on: `required_attributes` are the filter
 * dimensions of TD-0002, so one write here reshapes every facet, every landing and the
 * specification table of every product. All four writes carry
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)`.
 *
 * `PUT /:id` (replace) gets its own row next to `PATCH /:id` on purpose — it is the handler a
 * guard regression forgets first, because the two share a path and only differ in the verb.
 */
const WRITE_ENDPOINTS: WriteRow[] = [
	['post', '/categories', {}, categoryService.create],
	['patch', `/categories/${CATEGORY_ID}`, {}, categoryService.update],
	['put', `/categories/${CATEGORY_ID}`, {}, categoryService.replace],
	['delete', `/categories/${CATEGORY_ID}`, undefined, categoryService.delete]
]

/**
 * The three reads are public **deliberately**, and they are listed here so that closing one of
 * them by accident fails just as loudly as opening a write: a category document carries no
 * supplier and no internal field, while the header menu, the catalogue sidebar and every
 * `/filament/...` page read them anonymously on the first render. A guard here empties the
 * navigation for every visitor who is not logged in as an admin.
 */
const PUBLIC_GETS: [path: string, handler: jest.Mock][] = [
	['/categories', categoryService.findAll],
	['/categories/slug/filament', categoryService.findBySlug],
	[`/categories/${CATEGORY_ID}`, categoryService.findById]
]

describe('CategoryController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [CategoryController],
			providers: [{ provide: CategoryService, useValue: categoryService }]
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
			await send(app, 'post', '/categories', { role: Role.ADMIN, body: { name: 'Філамент' } })

			expect(categoryService.create).toHaveBeenCalledTimes(1)
			expect(categoryService.create).toHaveBeenCalledWith({ name: 'Філамент' })
		})
	})

	/**
	 * Guards in one `@UseGuards(...)` run left to right, and `RolesGuard` reads `req.user.role`.
	 * Listed the other way round it answers before the token is validated and sees no user at
	 * all: an anonymous caller would then get 403 instead of 401, and — the part that actually
	 * breaks the admin — a real ADMIN would get 403 too. The two assertions below are what tells
	 * the correct order from the swapped one.
	 */
	describe('JwtAuthGuard runs before RolesGuard', () => {
		it('answers 401, not 403, when the write carries no token at all', async () => {
			const res = await send(app, 'delete', `/categories/${CATEGORY_ID}`)

			expect(res.status).toBe(401)
		})

		it('lets an ADMIN through, which a RolesGuard-first chain never would', async () => {
			const res = await send(app, 'delete', `/categories/${CATEGORY_ID}`, {
				role: Role.ADMIN
			})

			expect(res.status).toBe(200)
			expect(categoryService.delete).toHaveBeenCalledTimes(1)
		})
	})

	describe('storefront read endpoints stay public', () => {
		it.each(PUBLIC_GETS)('GET %s → 200 without a token', async (path, handler) => {
			const res = await send(app, 'get', path)

			expect(res.status).toBe(200)
			expect(handler).toHaveBeenCalledTimes(1)
		})
	})

	/** '/slug/:slug' is declared before '/:id'; the reverse order sends slugs to `findById`. */
	it("resolves '/categories/slug/:slug' to findBySlug and not to the ':id' route", async () => {
		await send(app, 'get', '/categories/slug/filament')

		expect(categoryService.findBySlug).toHaveBeenCalledWith('filament')
		expect(categoryService.findById).not.toHaveBeenCalled()
	})
})
