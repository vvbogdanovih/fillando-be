import { Injectable } from '@nestjs/common'

/**
 * How long one regeneration covers the promo writes that follow it. A product-wide promotion
 * is one request, but an admin editing several variants in a row would otherwise rebuild the
 * whole feed once per click.
 */
const DEBOUNCE_MS = 5000

/**
 * "Something a shopper pays changed — rebuild the Merchant feed" (TD-0012).
 *
 * `ProductService` raises it after a promo write; `FeedCronService` is the one listener and
 * regenerates. A signal rather than an injection because `FeedModule` imports `ProductModule`:
 * the product side cannot see `FeedService` without a cycle, and it does not need to — it only
 * has to say that the feed is stale.
 *
 * Fire-and-forget like `storefrontRevalidation`: {@link request} never rejects, and with nobody
 * subscribed (unit tests, a process without the feed module) it is a no-op. Same module-singleton
 * reasoning too: the debounce window only works when every writer shares one instance.
 */
@Injectable()
export class FeedRefreshSignal {
	private listener: ((trigger: string) => void) | null = null
	private timer: NodeJS.Timeout | null = null
	private readonly triggers = new Set<string>()

	/** One subscriber — the last to subscribe wins, which is what a test re-wiring it wants. */
	subscribe(listener: (trigger: string) => void): void {
		this.listener = listener
	}

	request(trigger: string): void {
		if (!this.listener) return
		this.triggers.add(trigger)
		if (this.timer) return
		this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS)
		// A pending rebuild must never be the reason the process stays alive.
		this.timer.unref()
	}

	private flush(): void {
		this.timer = null
		const trigger = [...this.triggers].join(', ')
		this.triggers.clear()
		this.listener?.(trigger)
	}
}

export const feedRefresh = new FeedRefreshSignal()
