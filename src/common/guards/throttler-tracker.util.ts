import type { Request } from 'express'
import { clientIp } from './client-ip.util'

/**
 * The address a rate limit is counted against: the visitor, not the proxy in front of the app
 * (`clientIp` — `CF-Connecting-IP` when the request came from a Cloudflare edge, P11).
 *
 * `@nestjs/throttler` keys on `req.ip` by default, and behind Cloudflare that is the edge node —
 * every visitor arriving through it would share one allowance (ten orders a minute for the whole
 * shop), while a caller through another edge went uncounted (Plan-0005 I-39).
 *
 * Whether the origin can be reached around Cloudflare at all is a deployment property; a request
 * that does is keyed by its own address, never by a header it sent.
 */
export function throttlerTracker(req: Request): Promise<string> {
	return Promise.resolve(clientIp(req) ?? 'unknown')
}
