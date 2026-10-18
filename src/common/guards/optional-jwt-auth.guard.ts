import { Injectable, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { ENV } from 'src/common/constants'

/**
 * "Optional" means the *cookie* is optional, not its validity: a caller without an access cookie
 * is a guest, a caller whose cookie failed verification (expired, bad signature) gets 401.
 *
 * The distinction is what lets the storefront refresh a session. Its HTTP client refreshes only
 * on 401, so when `GET /auth/me` answered 200 `{ user: null }` for an expired access JWT, a tab
 * reloaded more than `JWT_EXPIRATION` minutes after the last refresh looked logged out while the
 * refresh cookie was still good for days. `POST /orders` had the mirror image: an expired JWT
 * silently placed the order as a guest instead of under the account.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
	handleRequest<TUser = unknown>(
		err: unknown,
		user: unknown,
		_info: unknown,
		context: ExecutionContext,
		_status?: unknown
	): TUser {
		if (err && !(err instanceof UnauthorizedException)) {
			throw err
		}
		if (user) return user as TUser

		const req = context.switchToHttp().getRequest<Request>()
		if (req.cookies?.[ENV.ACCSESS_TOKEN_NAME]) {
			throw new UnauthorizedException('Access token недійсний або протермінований.')
		}

		return null as TUser
	}
}
