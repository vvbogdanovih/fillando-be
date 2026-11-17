import { RequestMethod, type INestApplication, type Type } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { createRbacApp, send, type HttpMethod } from 'src/common/testing/rbac-harness'
import { ROLES_KEY } from 'src/common/decorators/roles.decorator'
import { Role } from 'src/common/types/enums'
import { CatalogRoutesController } from '../catalog-routes/catalog-routes.controller'
import {
	CatalogOperationController,
	CategoryDraftPlacementController
} from '../category/category-draft-placement'
import { CategoryExportController } from '../category/category-export'
import { CategoryPublicationController } from '../category/category-publication'
import { CategorySeoController } from '../category/category-seo'
import { ColorAdminController } from '../color/color-admin'
import { TypedLandingController } from '../landing/typed-landing.controller'
import { TypedProductController } from '../product/typed-product.controller'
import { StorefrontSettingsController } from '../storefront/storefront-settings'
import { CatalogSitemapController } from './catalog-sitemap'

/**
 * Every route of the catalogue controllers Plan-0010 added, read from Nest's own metadata so a
 * new route is covered the day it is added (`src/docs/RBAC.md`): a route is either on the public
 * list below or ADMIN-only — anonymous 401, a signed-in USER 403, and the service never reached.
 */
const CONTROLLERS: Type<unknown>[] = [
	CategoryDraftPlacementController,
	CatalogOperationController,
	CategorySeoController,
	CategoryExportController,
	CategoryPublicationController,
	ColorAdminController,
	TypedLandingController,
	TypedProductController,
	CatalogRoutesController,
	StorefrontSettingsController,
	CatalogSitemapController
]
/** What the storefront and Merchant read without signing in. */
const PUBLIC = new Set([
	'GET /storefront-settings',
	'GET /routes/resolve',
	'GET /catalog/sitemap',
	'GET /catalog/sitemap/part'
])
const VERBS: Partial<Record<RequestMethod, HttpMethod>> = {
	[RequestMethod.GET]: 'get',
	[RequestMethod.POST]: 'post',
	[RequestMethod.PATCH]: 'patch',
	[RequestMethod.PUT]: 'put',
	[RequestMethod.DELETE]: 'delete'
}
const join = (...parts: string[]) =>
	`/${parts
		.flatMap(part => part.split('/'))
		.filter(Boolean)
		.join('/')}`

function routesOf(controller: Type<unknown>) {
	const base = Reflect.getMetadata(PATH_METADATA, controller) as string
	const prototype = controller.prototype as Record<string, unknown>
	return Object.getOwnPropertyNames(prototype).flatMap(name => {
		const handler = prototype[name]
		if (name === 'constructor' || typeof handler !== 'function') return []
		const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined
		const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined
		if (path === undefined || method === undefined) return []
		const roles = (Reflect.getMetadata(ROLES_KEY, handler) ??
			Reflect.getMetadata(ROLES_KEY, controller)) as Role[] | undefined
		const verb = VERBS[method]!
		const route = join(base, path)
		return [
			{ name, verb, route, url: route.replace(/:[a-zA-Z]+/g, '0'.repeat(23) + '1'), roles }
		]
	})
}

/** A service whose every method records its call — a guard that lets a request through shows. */
function recordingService() {
	const calls: string[] = []
	const service = new Proxy(
		{},
		{
			get: (_target, key) =>
				typeof key === 'symbol' || key === 'then'
					? undefined
					: () => {
							calls.push(String(key))
							return Promise.resolve({})
						}
		}
	)
	return { service, calls }
}

describe.each(CONTROLLERS.map(controller => [controller.name, controller] as const))(
	'%s',
	(_name, controller) => {
		const { service, calls } = recordingService()
		let app: INestApplication
		beforeAll(async () => {
			const [dependency] = Reflect.getMetadata(
				'design:paramtypes',
				controller
			) as Type<unknown>[]
			app = await createRbacApp({
				controllers: [controller],
				providers: [{ provide: dependency, useValue: service }]
			})
		})
		afterAll(async () => {
			await app.close()
		})

		const routes = routesOf(controller)
		it('has routes', () => expect(routes.length).toBeGreaterThan(0))
		it.each(
			routes.map(route => [`${route.verb.toUpperCase()} ${route.route}`, route] as const)
		)('%s', async (key, route) => {
			if (PUBLIC.has(key)) {
				expect(route.roles).toBeUndefined()
				return
			}
			expect(route.roles).toEqual([Role.ADMIN])
			calls.length = 0
			expect((await send(app, route.verb, route.url, { body: {} })).status).toBe(401)
			expect(
				(await send(app, route.verb, route.url, { role: Role.USER, body: {} })).status
			).toBe(403)
			expect(calls).toEqual([])
			const admin = await send(app, route.verb, route.url, { role: Role.ADMIN, body: {} })
			expect([401, 403]).not.toContain(admin.status)
		})
	}
)
