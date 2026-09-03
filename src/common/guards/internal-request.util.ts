import { ExecutionContext } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import { ENV } from 'src/common/constants'

export const INTERNAL_TOKEN_HEADER = 'x-internal-token'

/**
 * `skipIf` for the rate limiter: the frontend's server-side fetches all come from one
 * container and would otherwise look like a single abusive client. They identify
 * themselves with `X-Internal-Token` = `INTERNAL_API_TOKEN` (shared secret, both repos).
 * Never throws; with no configured token nothing is exempted.
 */
export function isInternalRequest(context: ExecutionContext): boolean {
	const expected = ENV.INTERNAL_API_TOKEN
	if (!expected) return false

	const req = context.switchToHttp().getRequest<Request>()
	const raw = req.headers[INTERNAL_TOKEN_HEADER]
	const provided = Array.isArray(raw) ? raw[0] : raw
	if (typeof provided !== 'string') return false

	const a = Buffer.from(provided)
	const b = Buffer.from(expected)
	return a.length === b.length && timingSafeEqual(a, b)
}
