import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
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
 * **Fire-and-forget.** {@link revalidate} returns `void` and never rejects: a purge that fails
 * is a warning in the log and the cached copy then expires on its own schedule. Nothing an
 * admin saves may fail because the storefront was unreachable.
 */
@Injectable()
export class StorefrontRevalidationService {
	private readonly logger = new Logger(StorefrontRevalidationService.name)
	private readonly windows = new Map<StorefrontResource, PurgeWindow>()

	/**
	 * Purge `resource`, now or at the end of the window a previous purge opened.
	 *
	 * `trigger` only reaches the log line, so it can be as coarse or as specific as the caller
	 * likes; several triggers collapsed into one purge are logged together.
	 */
	revalidate(resource: StorefrontResource, trigger: string): void {
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

	private async post(resource: StorefrontResource, trigger: string): Promise<void> {
		const url = `${ENV.FRONTEND_URL.replace(/\/$/, '')}/api/revalidate`
		try {
			await axios.post(
				url,
				{ resource },
				{
					timeout: REVALIDATE_TIMEOUT_MS,
					headers: {
						'Content-Type': 'application/json',
						// Unset is a supported state: the frontend accepts an unauthenticated
						// call outside production and answers 503 in it, which lands in the log
						// below rather than anywhere a shopper or an admin can see.
						...(ENV.REVALIDATE_SECRET
							? { 'x-revalidate-secret': ENV.REVALIDATE_SECRET }
							: {})
					}
				}
			)
			this.logger.log(`Storefront ${resource} cache purged after ${trigger}`)
		} catch (err) {
			const status = axios.isAxiosError(err) ? err.response?.status : undefined
			this.logger.warn(
				`Storefront ${resource} revalidation after ${trigger} failed${status ? ` (${status})` : ''}: ${(err as Error).message} — the cached copy expires on its own`
			)
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
