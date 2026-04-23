import { Injectable, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ExecutionContext } from '@nestjs/common'

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
	handleRequest<TUser = unknown>(
		err: unknown,
		user: unknown,
		_info: unknown,
		_context: ExecutionContext,
		_status?: unknown
	): TUser {
		if (err && !(err instanceof UnauthorizedException)) {
			throw err
		}

		return (user ?? null) as TUser
	}
}
