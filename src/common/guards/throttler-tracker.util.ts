import type { Request } from 'express'

/**
 * The address a rate limit is counted against.
 *
 * `@nestjs/throttler` keys on `req.ip` by default, and `main.ts` sets `trust proxy 1` — so
 * behind a proxy the default counts every visitor arriving through that proxy as one client:
 * ten orders a minute for the whole shop, while an attacker coming via another edge node is
 * not limited at all. Production sits behind Cloudflare and Nginx Proxy Manager, which is
 * exactly that shape, and `src/docs/API_AND_SWAGGER.md` §4a has been describing this
 * behaviour rather than the one the code had (Plan-0005 I-39).
 *
 * `req.ips` is the `X-Forwarded-For` chain Express exposes once `trust proxy` is set, ordered
 * client-first, so its head is the closest thing to the real caller this app can see. It falls
 * back to `req.ip` when the chain is empty — a direct request, or a proxy that forwards no
 * header.
 *
 * What this does NOT do is decide whether the header can be trusted: any client that can reach
 * the app without passing through the proxy can put whatever it likes in `X-Forwarded-For`.
 * Keeping the app unreachable except through the proxy is a deployment property, and verifying
 * it is a release step (Plan-0005 A1), not something a tracker can assert.
 */
export function throttlerTracker(req: Request): Promise<string> {
	return Promise.resolve(req.ips?.[0] ?? req.ip ?? 'unknown')
}
