import { SetMetadata } from '@nestjs/common'
import { Role } from '../types/enums'

export const ROLES_KEY = 'roles'

/**
 * Typed as `Role[]` on purpose: with `string[]` a typo such as `@Roles('ADMN')`
 * compiled fine and silently locked the endpoint for everyone.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles)
