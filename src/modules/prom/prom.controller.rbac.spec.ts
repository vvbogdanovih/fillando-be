import { INestApplication } from '@nestjs/common'
import { getLoggerToken } from 'nestjs-pino'
import { of } from 'rxjs'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { PromController } from './prom.controller'
import { PromSyncService } from './prom-sync.service'

const SYNC_PATH = '/prom/sync-availability'

/**
 * `@Sse` answers `text/event-stream` and supertest waits for the response to end, so an
 * observable that never completes hangs the spec instead of failing it. The real service returns
 * a Subject it completes once the sync finishes; the mock returns a completing `of(...)`, which
 * makes Nest call `response.end()` and gives the ADMIN row a real 200 to assert.
 *
 * The mock emits TWO events on purpose. `syncWithProgress` emits one `progress` frame per batch
 * and then a single `done` frame (prom-sync.service.ts `syncWithProgress`), so a handler that
 * returned only the head of the stream — `.pipe(take(1))`, `first()`, anything dropping trailing
 * emissions — would silently kill the admin's progress UI while still answering 200 with
 * `text/event-stream`. A single-emission mock cannot tell those apart; two can.
 */
const promSyncService = {
	syncWithProgress: jest.fn()
}

const PROGRESS_EVENT = { data: { type: 'progress', total: 2, processed: 1, updated: 1 } }
const DONE_EVENT = { data: { type: 'done', total: 2, processed: 2, updated: 2 } }

/** SSE frames as the client sees them: one `data:` line per emission Nest forwarded. */
const dataFrames = (text: string) => text.split('\n').filter(line => line.startsWith('data:'))

/**
 * Paths that must NOT exist — this controller has exactly one handler, and it is admin-only.
 * Every verb is listed, not just `get`/`post`: a stray `@Patch()` on the base path is as much a
 * hole as a stray `@Get()`, and only an explicit row notices it.
 */
const STRAY_ROUTES: [method: HttpMethod, path: string][] = [
	['get', '/prom'],
	['post', '/prom'],
	['patch', '/prom'],
	['put', '/prom'],
	['delete', '/prom'],
	['post', SYNC_PATH],
	['patch', SYNC_PATH],
	['put', SYNC_PATH],
	['delete', SYNC_PATH]
]

/**
 * `GET /prom/sync-availability` is the entire controller, and it is the most expensive button in
 * the admin: the sync walks every variant carrying a `prom_id` and writes back both `stock` and
 * `price`. Fillando resells, so a price is always "supplier price + margin" and this job
 * overwrites the catalogue's prices by design. An unauthenticated caller therefore reads nothing
 * — it rewrites the price of the whole shop from the supplier's current data. That is what the
 * ADMIN row below defends: `RolesGuard` is default-deny, so a dropped `@Roles(Role.ADMIN)`
 * answers 403 to everyone and only the ADMIN row notices, and a swapped
 * `@UseGuards(RolesGuard, JwtAuthGuard)` answers 403 to an anonymous caller and to a real ADMIN
 * alike — only "401 anonymous" plus "2xx ADMIN" together tell the correct order from that.
 */
describe('PromController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [PromController],
			providers: [
				{ provide: PromSyncService, useValue: promSyncService },
				{ provide: getLoggerToken(PromController.name), useValue: { info: jest.fn() } }
			]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
		promSyncService.syncWithProgress.mockReturnValue(of(PROGRESS_EVENT, DONE_EVENT))
	})

	describe('the availability + price sync is admin-only', () => {
		it('GET /prom/sync-availability → 401 without a token', async () => {
			const res = await send(app, 'get', SYNC_PATH)

			expect(res.status).toBe(401)
			expect(promSyncService.syncWithProgress).not.toHaveBeenCalled()
		})

		it('GET /prom/sync-availability → 403 for USER', async () => {
			const res = await send(app, 'get', SYNC_PATH, { role: Role.USER })

			expect(res.status).toBe(403)
			expect(promSyncService.syncWithProgress).not.toHaveBeenCalled()
		})

		/** `@Roles` carries `Role[]`, never strings — a lookalike role must not open the price sync. */
		it('GET /prom/sync-availability → 403 for a role outside the enum', async () => {
			const res = await send(app, 'get', SYNC_PATH, { role: 'admin' })

			expect(res.status).toBe(403)
			expect(promSyncService.syncWithProgress).not.toHaveBeenCalled()
		})

		it('GET /prom/sync-availability → 200 event stream for ADMIN', async () => {
			const res = await send(app, 'get', SYNC_PATH, { role: Role.ADMIN })

			expect(res.status).toBe(200)
			expect(res.headers['content-type']).toMatch(/text\/event-stream/)
			expect(promSyncService.syncWithProgress).toHaveBeenCalledTimes(1)
		})

		/**
		 * The admin watches this run for minutes, so the whole progress sequence has to reach the
		 * browser — not just the frame the stream opened with, and not just the one it closed with.
		 */
		it('GET /prom/sync-availability → forwards every progress frame to ADMIN', async () => {
			const res = await send(app, 'get', SYNC_PATH, { role: Role.ADMIN })

			expect(dataFrames(res.text)).toHaveLength(2)
			expect(res.text).toContain('"type":"progress"')
			expect(res.text).toContain('"type":"done"')
		})
	})

	describe('nothing else on the controller answers', () => {
		it.each(STRAY_ROUTES)('%s %s → 404 without a token', async (method, path) => {
			const res = await send(app, method, path, { body: {} })

			expect(res.status).toBe(404)
			expect(promSyncService.syncWithProgress).not.toHaveBeenCalled()
		})
	})
})
