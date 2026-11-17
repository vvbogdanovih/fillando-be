import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import type { mongo } from 'mongoose'
import { ENV } from 'src/common/constants'

/**
 * What an admin write may ask the storefront to drop.
 *
 * The same list is closed on the frontend (`INVALIDATIONS` in
 * `fillando-fe/src/app/api/revalidate/route.ts`): a resource missing there purges nothing and
 * answers 400, so a new name has to be added on both sides. The caller never names a tag, a
 * path or a slug — that is what keeps the blast radius out of the request body.
 */
export type StorefrontResource = 'landings' | 'products' | 'categories'

/** The storefront caches its backend reads for an hour; this is how long we wait for its purge. */
const REVALIDATE_TIMEOUT_MS = 3000

/**
 * How long one purge covers the writes that follow it.
 *
 * The Prom availability sync rewrites stock and price for the whole catalogue, one variant at a
 * time — a purge per write would be a request storm against a single Next process for no gain,
 * since every one of them expires the same coarse tag. So the first write of a burst purges
 * immediately (the admin's ordinary single save is never delayed) and the rest of the window
 * collapses into one trailing purge, which carries the last write. Worst case the shopper sees
 * a bulk write this many milliseconds late instead of up to an hour late.
 */
const THROTTLE_WINDOW_MS = 5000

/**
 * Without the outbox (a process that never attached one — scripts, unit tests): a purge that fails
 * is tried this many times in all, this long apart; a refusal a retry cannot change (a wrong
 * secret, an unknown resource) is not retried.
 */
const RETRY_ATTEMPTS = 3
const RETRY_PAUSE_MS = 2000

/**
 * The purge outbox (P12, owner decision 02.11.2026; TD-0013 catalog mutations §4): one pending
 * purge per resource, kept in MongoDB until the storefront acknowledges it with a 2xx — through a
 * storefront outage, a wrong secret, a restart of this process.
 */
export const PURGE_OUTBOX = 'storefront_purges'
export interface OutboxTimings {
	/** How often the outbox is checked for due purges (and right after a new one). */
	pollMs: number
	/** A claimed purge another process may take over after this long without an answer. */
	leaseMs: number
	/**
	 * A second purge this long after an acknowledged one (P15): a render that read the old data
	 * before the first purge and wrote its cache entry after it would otherwise keep serving it
	 * until the hour lapses; the echo expires that entry too.
	 */
	echoMs: number
	/** At most one delivery per resource this often (`THROTTLE_WINDOW_MS`). */
	windowMs: number
	/** Retry pause after the first failure, doubling up to `maxBackoffMs`. */
	backoffMs: number
	maxBackoffMs: number
}
const OUTBOX_TIMINGS: OutboxTimings = {
	pollMs: 1000,
	windowMs: THROTTLE_WINDOW_MS,
	leaseMs: 30_000,
	echoMs: 10_000,
	backoffMs: 2000,
	maxBackoffMs: 5 * 60_000
}
interface PendingPurge {
	_id: StorefrontResource
	/** What asked for it since the last delivery — the log line. */
	triggers: string[]
	/** Bumped by every new request: a delivery only clears what it carried. */
	version: number
	due_at: Date
	attempts: number
	lease_until: Date | null
	/** The echo of a delivered purge (P15), not a new request. */
	echo: boolean
	last_sent_at: Date | null
	last_error?: string
}

/**
 * What stays stale on the storefront, for up to its hour, when a purge of a resource finally fails —
 * the pages behind the tags the storefront's `INVALIDATIONS` expire for it (fillando-fe
 * `src/app/api/revalidate/route.ts`), named in the warning so the operator knows what to check.
 */
const STALE_PATHS: Record<StorefrontResource, string[]> = {
	categories: [
		'/catalog',
		'/{category}',
		'/{category}/{landing}',
		'/products/{slug}',
		'the header menu',
		'/sitemap.xml'
	],
	products: [
		'/products/{slug}',
		'/catalog',
		'/{category}',
		'/{category}/{landing}',
		'/sitemap.xml'
	],
	landings: ['/{category}/{landing}', '/{category} (landing tiles)', '/sitemap.xml']
}

/** An open window: a purge has already gone out, and `triggers` is what is owed after it. */
interface PurgeWindow {
	timer: NodeJS.Timeout
	triggers: Set<string>
}

/**
 * Tells the storefront to drop its cached reads of one resource (`POST /api/revalidate`) so an
 * admin write is visible on the next request rather than when the hour lapses.
 *
 * Server-to-server on purpose: the browser cannot hold the secret, and the Next server cannot
 * recognise an admin (the backend's auth cookies are host-only) — see fillando-fe
 * `docs/cache-revalidation.md` and this repo's `src/docs/STOREFRONT_REVALIDATION.md`.
 *
 * **Fire-and-forget.** {@link revalidate} returns `void` and never rejects: a purge that fails is
 * retried (`RETRY_ATTEMPTS`), then a warning naming what stays stale, and the cached copy then
 * expires on its own schedule (up to an hour). Nothing an admin saves may fail because the
 * storefront was unreachable.
 */
@Injectable()
export class StorefrontRevalidationService {
	private readonly logger = new Logger(StorefrontRevalidationService.name)
	private readonly windows = new Map<StorefrontResource, PurgeWindow>()
	private outbox: mongo.Collection<PendingPurge> | null = null
	private timings = OUTBOX_TIMINGS
	private poll: NodeJS.Timeout | null = null
	private draining: Promise<void> | null = null
	private endpoint: string | null = null

	/**
	 * Purges go through the outbox in `db` from now on, delivered by this process's poll (P12).
	 * The app attaches it once at start (`StorefrontPurgeOutbox`); `endpoint` and `timings` are
	 * for tests.
	 */
	attach(
		db: mongo.Db,
		options: { endpoint?: string; timings?: Partial<OutboxTimings> } = {}
	): void {
		this.detach()
		this.outbox = db.collection<PendingPurge>(PURGE_OUTBOX)
		this.endpoint = options.endpoint ?? null
		this.timings = { ...OUTBOX_TIMINGS, ...options.timings }
		this.poll = setInterval(() => void this.drain(), this.timings.pollMs)
		this.poll.unref()
		void this.drain()
	}
	/** Stops the poll (the app's shutdown, a test); pending purges stay for the next process. */
	detach(): void {
		if (this.poll) clearInterval(this.poll)
		this.poll = null
		this.outbox = null
	}

	/**
	 * Purge `resource`, now or at the end of the window a previous purge opened.
	 *
	 * `trigger` only reaches the log line, so it can be as coarse or as specific as the caller
	 * likes; several triggers collapsed into one purge are logged together.
	 */
	revalidate(resource: StorefrontResource, trigger: string): void {
		if (this.outbox) {
			const outbox = this.outbox
			void this.enqueue(outbox, resource, trigger).then(
				() => this.drain(),
				error => {
					// The outbox itself failed (MongoDB unreachable): what is left is the direct path.
					this.logger.warn(
						`Storefront ${resource} purge after ${trigger} not queued (${(error as Error).message}); sending it directly`
					)
					this.direct(resource, trigger)
				}
			)
			return
		}
		this.direct(resource, trigger)
	}

	/** Without the outbox: now, or at the end of the window a previous purge opened. */
	private direct(resource: StorefrontResource, trigger: string): void {
		const open = this.windows.get(resource)
		if (open) {
			open.triggers.add(trigger)
			return
		}
		this.openWindow(resource)
		void this.post(resource, trigger)
	}

	private openWindow(resource: StorefrontResource): void {
		const timer = setTimeout(() => this.closeWindow(resource), THROTTLE_WINDOW_MS)
		// A purge that is merely owed must never be the reason the process stays alive.
		timer.unref()
		this.windows.set(resource, { timer, triggers: new Set() })
	}

	private closeWindow(resource: StorefrontResource): void {
		const open = this.windows.get(resource)
		this.windows.delete(resource)
		if (!open?.triggers.size) return
		// Re-opened rather than just closed: a sync that is still writing has to stay at one
		// purge per window instead of going back to one per write the moment the window lapses.
		this.openWindow(resource)
		void this.post(resource, [...open.triggers].join(', '))
	}

	/**
	 * One pending purge per resource: a new request joins it (its trigger, a new version). Due at
	 * once — or at the end of the window after the last delivery (a burst stays one purge per
	 * window); a purge already waiting out a failure keeps its retry time.
	 */
	private async enqueue(
		outbox: mongo.Collection<PendingPurge>,
		resource: StorefrontResource,
		trigger: string
	) {
		const now = new Date()
		await outbox.updateOne(
			{ _id: resource },
			[
				{
					$set: {
						triggers: { $setUnion: [{ $ifNull: ['$triggers', []] }, [trigger]] },
						version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
						echo: false,
						attempts: { $ifNull: ['$attempts', 0] },
						lease_until: { $ifNull: ['$lease_until', null] },
						last_sent_at: { $ifNull: ['$last_sent_at', null] },
						due_at: {
							$cond: [
								{ $gt: [{ $ifNull: ['$attempts', 0] }, 0] },
								'$due_at',
								{
									$max: [
										now,
										{
											$add: [
												{ $ifNull: ['$last_sent_at', new Date(0)] },
												this.timings.windowMs
											]
										}
									]
								}
							]
						}
					}
				}
			],
			{ upsert: true }
		)
	}

	/**
	 * Delivers every due purge, one claim at a time (a lease, so two processes never send the same
	 * one): acknowledged — removed, or turned into its echo; refused or unanswered — kept, retried
	 * after a doubling pause, and a warning naming what stays stale on the 3rd and every 10th try.
	 */
	drain(): Promise<void> {
		if (this.draining) return this.draining
		this.draining = (async () => {
			try {
				for (;;) {
					const outbox = this.outbox
					if (!outbox) return
					const now = new Date()
					const claim = await outbox.findOneAndUpdate(
						{
							due_at: { $lte: now },
							$or: [{ lease_until: null }, { lease_until: { $lt: now } }]
						},
						{ $set: { lease_until: new Date(now.getTime() + this.timings.leaseMs) } },
						{ returnDocument: 'after' }
					)
					if (!claim) return
					await this.deliver(outbox, claim)
				}
			} catch (error) {
				this.logger.warn(`Storefront purge outbox unavailable: ${(error as Error).message}`)
			} finally {
				this.draining = null
			}
		})()
		return this.draining
	}

	private async deliver(outbox: mongo.Collection<PendingPurge>, claim: PendingPurge) {
		const trigger = claim.echo ? 'echo' : claim.triggers.join(', ')
		const sent = await this.send(claim._id)
		const now = new Date()
		if (sent.ok) {
			this.logger.log(`Storefront ${claim._id} cache purged after ${trigger}`)
			// Only what this delivery carried: a request that arrived meanwhile stays due.
			const done = claim.echo
				? await outbox.deleteOne({ _id: claim._id, version: claim.version })
				: await outbox.updateOne(
						{ _id: claim._id, version: claim.version },
						{
							$set: {
								triggers: [],
								echo: true,
								attempts: 0,
								lease_until: null,
								last_sent_at: now,
								due_at: new Date(now.getTime() + this.timings.echoMs)
							}
						}
					)
			if (!('deletedCount' in done ? done.deletedCount : done.matchedCount))
				await outbox.updateOne(
					{ _id: claim._id },
					{
						$set: {
							attempts: 0,
							lease_until: null,
							last_sent_at: now,
							due_at: new Date(now.getTime() + this.timings.windowMs)
						},
						$pullAll: { triggers: claim.triggers }
					}
				)
			return
		}
		const attempts = claim.attempts + 1
		const pause = Math.min(
			this.timings.backoffMs * 2 ** (attempts - 1),
			this.timings.maxBackoffMs
		)
		await outbox.updateOne(
			{ _id: claim._id },
			{
				$set: {
					attempts,
					lease_until: null,
					last_error: sent.error,
					due_at: new Date(now.getTime() + pause)
				}
			}
		)
		if (attempts === 3 || attempts % 10 === 0)
			this.logger.warn(
				`Storefront ${claim._id} revalidation after ${trigger} not acknowledged after ${attempts} attempts: ${sent.error} — kept in the outbox, retried every ${Math.round(pause / 1000)} s; stale until then: ${STALE_PATHS[claim._id].join(', ')}`
			)
	}

	/** One POST to the storefront; acknowledged only by a 2xx. */
	private async send(
		resource: StorefrontResource
	): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			await axios.post(
				this.url(),
				{ resource },
				{ timeout: REVALIDATE_TIMEOUT_MS, headers: this.headers() }
			)
			return { ok: true }
		} catch (err) {
			const status = axios.isAxiosError(err) ? err.response?.status : undefined
			return { ok: false, error: `${status ? `${status} ` : ''}${(err as Error).message}` }
		}
	}
	private url() {
		return this.endpoint ?? `${ENV.FRONTEND_URL.replace(/\/$/, '')}/api/revalidate`
	}
	private headers() {
		return {
			'Content-Type': 'application/json',
			// Unset is a supported state: the frontend accepts an unauthenticated call outside
			// production and answers 503 in it, which lands in the log rather than anywhere a
			// shopper or an admin can see.
			...(ENV.REVALIDATE_SECRET ? { 'x-revalidate-secret': ENV.REVALIDATE_SECRET } : {})
		}
	}

	private async post(resource: StorefrontResource, trigger: string): Promise<void> {
		const url = this.url()
		for (let attempt = 1; ; attempt++) {
			try {
				await axios.post(
					url,
					{ resource },
					{ timeout: REVALIDATE_TIMEOUT_MS, headers: this.headers() }
				)
				this.logger.log(`Storefront ${resource} cache purged after ${trigger}`)
				return
			} catch (err) {
				const status = axios.isAxiosError(err) ? err.response?.status : undefined
				// No answer, the storefront busy or failing: worth another try. A 4xx is not.
				const retryable = status === undefined || status === 429 || status >= 500
				if (retryable && attempt < RETRY_ATTEMPTS) {
					await new Promise(resolve => setTimeout(resolve, RETRY_PAUSE_MS).unref())
					continue
				}
				this.logger.warn(
					`Storefront ${resource} revalidation after ${trigger} failed${status ? ` (${status})` : ''} after ${attempt} attempt${attempt > 1 ? 's' : ''}: ${(err as Error).message} — stale until the cache expires (up to 1 h): ${STALE_PATHS[resource].join(', ')}`
				)
				return
			}
		}
	}
}

/**
 * The instance every admin write path shares.
 *
 * Deliberately a module singleton rather than a provider registered per module: the throttle
 * window is the whole point, and three module-local providers would be three windows — a bulk
 * write reaching the storefront through two of them would produce exactly the storm this class
 * exists to prevent. Services take it through an `@Optional()` constructor parameter defaulting
 * to this value, so no module wiring is needed and a test can hand over its own instance. If it
 * is ever registered for real, register it **once**, in a `@Global()` module.
 */
export const storefrontRevalidation = new StorefrontRevalidationService()
