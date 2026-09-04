import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { ROLES_KEY } from '../decorators/roles.decorator'
import { Role } from '../types/enums'
import type { JWTPayload } from '../types/jwt-payload'

/**
 * Must run after `JwtAuthGuard` (`@UseGuards(JwtAuthGuard, RolesGuard)`) — it reads
 * `req.user.role`, which only exists once the JWT has been validated.
 *
 * Default-deny: a handler guarded by `RolesGuard` without `@Roles(...)` is a
 * configuration mistake, so it is rejected rather than silently allowed through.
 */
@Injectable()
export class RolesGuard implements CanActivate {
	constructor(private reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
			context.getHandler(),
			context.getClass()
		])

		if (!requiredRoles?.length) {
			return false
		}

		const { user } = context.switchToHttp().getRequest<Request & { user?: JWTPayload }>()
		if (!user?.role) {
			return false
		}

		return requiredRoles.includes(user.role as Role)
	}
}
