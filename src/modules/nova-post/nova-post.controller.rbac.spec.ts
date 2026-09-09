import { INestApplication } from '@nestjs/common'
import { getLoggerToken } from 'nestjs-pino'
import { of } from 'rxjs'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { NovaPostWarehouseType, Role } from 'src/common/types/enums'
import { NovaPostSyncService } from './nova-post-sync.service'
import { NovaPostController } from './nova-post.controller'
import { NovaPostService } from './nova-post.service'

const CITY_REF = 'db5c88f5-391c-11dd-90d9-001a92567626'

/**
 * Every fixture holds three rows on purpose. With a single row `toEqual(FIXTURE)` cannot tell the
 * whole collection from `[collection[0]]`, and a picker that silently shows one city — or one
 * warehouse in a city that has hundreds — is exactly the kind of truncation a shopper hits at
 * checkout and no test would report.
 */
const KYIV_CITIES = [
	{ ref: CITY_REF, name: 'Київ', settlementType: 'місто', area: 'Київська' },
	{ ref: 'c-kyiv-obl', name: 'Києво-Святошинський', settlementType: 'район', area: 'Київська' },
	{ ref: 'c-kytsivka', name: 'Кицівка', settlementType: 'село', area: 'Харківська' }
]

const LVIV_CITIES = [
	{ ref: 'c-lviv', name: 'Львів', settlementType: 'місто', area: 'Львівська' },
	{ ref: 'c-lvivske', name: 'Львівське', settlementType: 'село', area: 'Львівська' },
	{ ref: 'c-nove-lviv', name: 'Нове Львівське', settlementType: 'село', area: 'Львівська' }
]

/**
 * Two queries, not one. `'Ки'` sits exactly on the `q.length < 2` boundary, so on its own it
 * cannot distinguish "the handler forwards q verbatim" from `q.slice(0, 2)` or from a hardcoded
 * literal; a longer, differently-shaped query is what pins the forwarding.
 */
const CITY_LOOKUPS: [query: string, cities: typeof KYIV_CITIES][] = [
	['Ки', KYIV_CITIES],
	['Львів', LVIV_CITIES]
]

const WAREHOUSES = [
	{ ref: 'w-12', number: 12, description: 'Відділення №12', cityRef: CITY_REF },
	{ ref: 'w-25', number: 25, description: 'Відділення №25', cityRef: CITY_REF },
	{ ref: 'w-107', number: 107, description: 'Відділення №107', cityRef: CITY_REF }
]

/**
 * The real `syncWithProgress` emits a `progress` event per upserted page and one `done` event
 * carrying the totals, then completes. The mock keeps that shape and gives every event a
 * distinctive number: a `done` marker alone would also be produced by a handler that called the
 * service purely for its side effect and returned a fabricated observable of its own, so the
 * counts and the frame order are what prove the service's stream is the one reaching the caller.
 */
const SYNC_EVENTS = [
	{ data: { type: 'progress', entity: 'cities', synced: 150 } },
	{ data: { type: 'progress', entity: 'warehouses', synced: 7000 } },
	{ data: { type: 'done', cities: 29123, warehouses: 11987 } }
]

const novaPostService = {
	searchCities: jest.fn(),
	getWarehouses: jest.fn()
}

const syncService = {
	syncWithProgress: jest.fn()
}

type AdminRow = [method: HttpMethod, path: string, handler: jest.Mock]

/**
 * The one admin operation in this controller. `GET /nova-post/sync` clears the city and
 * warehouse collections and refills them from the Nova Post API, so an unauthenticated caller
 * could both hammer the upstream API and leave the checkout address picker empty mid-run by
 * calling it in a loop. It must answer 401 anonymous / 403 USER / 2xx ADMIN — the 401 and the
 * ADMIN rows together are what proves the guard ORDER, since a swapped
 * `@UseGuards(RolesGuard, JwtAuthGuard)` answers 403 to both an anonymous caller and an ADMIN.
 */
const ADMIN_ENDPOINTS: AdminRow[] = [['get', '/nova-post/sync', syncService.syncWithProgress]]

describe('NovaPostController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [NovaPostController],
			providers: [
				{ provide: NovaPostService, useValue: novaPostService },
				{ provide: NovaPostSyncService, useValue: syncService },
				{ provide: getLoggerToken(NovaPostController.name), useValue: { info: jest.fn() } }
			]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
		novaPostService.searchCities.mockResolvedValue(KYIV_CITIES)
		novaPostService.getWarehouses.mockResolvedValue(WAREHOUSES)
		/**
		 * `@Sse` keeps the response open until the observable completes, and Nest only calls
		 * `response.end()` on `complete`. A `Subject` (what the real service returns) would leave
		 * supertest waiting forever, so the mock emits the production-shaped events and completes.
		 */
		syncService.syncWithProgress.mockReturnValue(of(...SYNC_EVENTS))
	})

	describe('the manual re-sync is admin-only', () => {
		it.each(ADMIN_ENDPOINTS)('%s %s → 401 without a token', async (method, path, handler) => {
			const res = await send(app, method, path)

			expect(res.status).toBe(401)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_ENDPOINTS)('%s %s → 403 for USER', async (method, path, handler) => {
			const res = await send(app, method, path, { role: Role.USER })

			expect(res.status).toBe(403)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(ADMIN_ENDPOINTS)('%s %s → 2xx for ADMIN', async (method, path, handler) => {
			const res = await send(app, method, path, { role: Role.ADMIN })

			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			expect(handler).toHaveBeenCalledTimes(1)
		})

		it('streams every event of the service stream to ADMIN as text/event-stream', async () => {
			const res = await send(app, 'get', '/nova-post/sync', { role: Role.ADMIN })

			expect(res.headers['content-type']).toMatch(/text\/event-stream/)

			const frames = [...res.text.matchAll(/^data: (.*)$/gm)].map(
				([, json]) => JSON.parse(json) as Record<string, unknown>
			)

			expect(frames).toEqual(SYNC_EVENTS.map(event => event.data))
		})
	})

	/**
	 * The checkout address picker runs before a shopper has any account — guest checkout is the
	 * default path. A guard added to either of these silently breaks delivery selection for every
	 * unregistered shopper: the storefront just starts getting 401 with nothing in the logs.
	 *
	 * Both handlers short-circuit to `[]` on a too-short/absent argument, so every assertion here
	 * sends arguments that get PAST that early return and checks the service was actually reached
	 * — otherwise the test would stay green with the service missing entirely.
	 */
	describe('checkout address lookups stay public', () => {
		it.each(CITY_LOOKUPS)(
			'GET /nova-post/cities?q=%s → 200 without a token, service reached with the query',
			async (query, cities) => {
				novaPostService.searchCities.mockResolvedValue(cities)

				const res = await send(
					app,
					'get',
					`/nova-post/cities?q=${encodeURIComponent(query)}`
				)

				expect(res.status).toBe(200)
				expect(res.body).toEqual(cities)
				expect(novaPostService.searchCities).toHaveBeenCalledTimes(1)
				expect(novaPostService.searchCities).toHaveBeenCalledWith(query)
			}
		)

		/**
		 * Every warehouse type goes through, not just `POST`: the picker offers parcel lockers and
		 * cargo departments too, and a handler that special-cased one enum member would pass a
		 * single-value assertion.
		 */
		it.each(Object.values(NovaPostWarehouseType))(
			'GET /nova-post/warehouses?type=%s → 200 without a token, service reached with all filters',
			async type => {
				const res = await send(
					app,
					'get',
					`/nova-post/warehouses?cityRef=${CITY_REF}&type=${type}&q=12`
				)

				expect(res.status).toBe(200)
				expect(res.body).toEqual(WAREHOUSES)
				expect(novaPostService.getWarehouses).toHaveBeenCalledTimes(1)
				expect(novaPostService.getWarehouses).toHaveBeenCalledWith(CITY_REF, type, '12')
			}
		)

		it('GET /nova-post/warehouses → 200 for a city without a type or search filter', async () => {
			const res = await send(app, 'get', `/nova-post/warehouses?cityRef=${CITY_REF}`)

			expect(res.status).toBe(200)
			expect(res.body).toEqual(WAREHOUSES)
			expect(novaPostService.getWarehouses).toHaveBeenCalledWith(
				CITY_REF,
				undefined,
				undefined
			)
		})
	})

	/**
	 * The documented short-circuits. They are the reason the assertions above pass real arguments:
	 * a one-letter query or a missing city never reaches the database, so a spec that queried with
	 * them would pass no matter what happened to the service or the route.
	 *
	 * The empty-string rows are the picker's pre-selection state — the field is rendered and its
	 * value submitted blank, so `?q=` and `?cityRef=` arrive as `''` rather than as absent params.
	 * Only they distinguish the falsy check the handlers do from a `=== undefined` check.
	 */
	describe('handler short-circuits', () => {
		it('GET /nova-post/cities answers [] for a query shorter than 2 characters', async () => {
			const res = await send(app, 'get', `/nova-post/cities?q=${encodeURIComponent('К')}`)

			expect(res.status).toBe(200)
			expect(res.body).toEqual([])
			expect(novaPostService.searchCities).not.toHaveBeenCalled()
		})

		it('GET /nova-post/cities answers [] for an empty query', async () => {
			const res = await send(app, 'get', '/nova-post/cities?q=')

			expect(res.status).toBe(200)
			expect(res.body).toEqual([])
			expect(novaPostService.searchCities).not.toHaveBeenCalled()
		})

		it('GET /nova-post/cities answers [] with no query at all', async () => {
			const res = await send(app, 'get', '/nova-post/cities')

			expect(res.status).toBe(200)
			expect(res.body).toEqual([])
			expect(novaPostService.searchCities).not.toHaveBeenCalled()
		})

		it('GET /nova-post/warehouses answers [] for an empty cityRef', async () => {
			const res = await send(app, 'get', '/nova-post/warehouses?cityRef=')

			expect(res.status).toBe(200)
			expect(res.body).toEqual([])
			expect(novaPostService.getWarehouses).not.toHaveBeenCalled()
		})

		it('GET /nova-post/warehouses answers [] without a cityRef', async () => {
			const res = await send(app, 'get', '/nova-post/warehouses')

			expect(res.status).toBe(200)
			expect(res.body).toEqual([])
			expect(novaPostService.getWarehouses).not.toHaveBeenCalled()
		})
	})
})
