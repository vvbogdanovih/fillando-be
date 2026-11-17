import { APP_PIPE } from '@nestjs/core'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { createRbacApp, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { CategoryTreeController } from './category-tree.controller'
import { CategoryTreeReadService } from './category-tree-read.service'
import { CategoryPublicReadService } from './category-public-read.service'
import { CategoryController } from './category.controller'
import { CategoryService } from './category.service'
const read = jest.fn().mockResolvedValue({ revision: 0, items: [], next_cursor: null })
const readOptions = jest.fn().mockResolvedValue({ revision: 0, items: [], next_cursor: null })
const findById = jest.fn()
const ancestorsPage = jest
	.fn()
	.mockResolvedValue({ revision: 0, total: 0, items: [], next_cursor: null })
let app: INestApplication
beforeAll(async () => {
	app = await createRbacApp({
		controllers: [CategoryTreeController, CategoryController],
		providers: [
			{
				provide: APP_PIPE,
				useValue: new ValidationPipe({ transform: true, whitelist: true })
			},
			{ provide: CategoryTreeReadService, useValue: { read, readOptions } },
			{ provide: CategoryPublicReadService, useValue: { ancestorsPage } },
			{ provide: CategoryService, useValue: { findById } }
		]
	})
})
afterAll(async () => {
	await app.close()
})
beforeEach(() => jest.clearAllMocks())
it('routes public tree before /:id and validates limits', async () => {
	expect((await send(app, 'get', '/categories/tree?limit=2')).status).toBe(200)
	expect(read).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }), false)
	expect(findById).not.toHaveBeenCalled()
	expect((await send(app, 'get', '/categories/tree?limit=0')).status).toBe(400)
	expect((await send(app, 'get', '/categories/tree?limit=1001')).status).toBe(400)
})
it('protects complete tree with ADMIN role', async () => {
	expect((await send(app, 'get', '/categories/admin/tree')).status).toBe(401)
	expect((await send(app, 'get', '/categories/admin/tree', { role: Role.USER })).status).toBe(403)
	expect(read).not.toHaveBeenCalled()
	expect((await send(app, 'get', '/categories/admin/tree', { role: Role.ADMIN })).status).toBe(
		200
	)
	expect(read).toHaveBeenCalledWith(expect.anything(), true)
})

it('routes children before /:id and validates the optional parent', async () => {
	expect((await send(app, 'get', '/categories/children')).status).toBe(200)
	expect(read).toHaveBeenCalledWith(expect.anything(), false, null)
	expect(findById).not.toHaveBeenCalled()
	expect((await send(app, 'get', '/categories/children?parent_id=bad')).status).toBe(400)
})

it('routes the public options before /:id and validates limits (Plan-0010 D06)', async () => {
	expect((await send(app, 'get', '/categories/options?limit=1000')).status).toBe(200)
	expect(readOptions).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }))
	expect(findById).not.toHaveBeenCalled()
	expect((await send(app, 'get', '/categories/options?limit=1001')).status).toBe(400)
})

it('serves a category path page publicly and validates limits (Plan-0010 D06.4)', async () => {
	const path = '/categories/00000000000000000000000A/ancestors'
	expect((await send(app, 'get', `${path}?limit=1000`)).status).toBe(200)
	expect(ancestorsPage).toHaveBeenCalledWith(
		'00000000000000000000000a',
		expect.objectContaining({ limit: 1000 })
	)
	expect(findById).not.toHaveBeenCalled()
	expect((await send(app, 'get', `${path}?limit=1001`)).status).toBe(400)
})
