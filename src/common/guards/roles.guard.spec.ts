import { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from '../decorators/roles.decorator'
import { Role } from '../types/enums'
import { RolesGuard } from './roles.guard'

const handler = () => undefined
class Ctrl {}

const buildContext = (user: unknown): ExecutionContext =>
	({
		getHandler: () => handler,
		getClass: () => Ctrl,
		switchToHttp: () => ({ getRequest: () => ({ user }) })
	}) as unknown as ExecutionContext

const buildGuard = (requiredRoles: Role[] | undefined) => {
	const getAllAndOverride = jest.fn().mockReturnValue(requiredRoles)
	const reflector = { getAllAndOverride } as unknown as Reflector
	return { guard: new RolesGuard(reflector), getAllAndOverride }
}

describe('RolesGuard', () => {
	it('reads @Roles metadata from the handler first, then the class', () => {
		const { guard, getAllAndOverride } = buildGuard([Role.ADMIN])

		guard.canActivate(buildContext({ role: Role.ADMIN }))

		expect(getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [handler, Ctrl])
	})

	describe('default-deny when no roles are configured', () => {
		it('denies when @Roles metadata is absent', () => {
			const { guard } = buildGuard(undefined)
			expect(guard.canActivate(buildContext({ role: Role.ADMIN }))).toBe(false)
		})

		it('denies when @Roles() is empty', () => {
			const { guard } = buildGuard([])
			expect(guard.canActivate(buildContext({ role: Role.ADMIN }))).toBe(false)
		})
	})

	describe('null-safety when JwtAuthGuard did not populate req.user', () => {
		it('denies when req.user is undefined', () => {
			const { guard } = buildGuard([Role.ADMIN])
			expect(guard.canActivate(buildContext(undefined))).toBe(false)
		})

		it('denies when req.user has no role', () => {
			const { guard } = buildGuard([Role.ADMIN])
			expect(guard.canActivate(buildContext({ id: 'u1', email: 'u1@test.invalid' }))).toBe(
				false
			)
		})
	})

	describe('role matching', () => {
		it('denies USER on an ADMIN-only handler', () => {
			const { guard } = buildGuard([Role.ADMIN])
			expect(guard.canActivate(buildContext({ role: Role.USER }))).toBe(false)
		})

		it('allows ADMIN on an ADMIN-only handler', () => {
			const { guard } = buildGuard([Role.ADMIN])
			expect(guard.canActivate(buildContext({ role: Role.ADMIN }))).toBe(true)
		})

		it('allows USER when the handler accepts [USER, ADMIN]', () => {
			const { guard } = buildGuard([Role.USER, Role.ADMIN])
			expect(guard.canActivate(buildContext({ role: Role.USER }))).toBe(true)
		})

		it('denies an unknown role string', () => {
			const { guard } = buildGuard([Role.ADMIN])
			expect(guard.canActivate(buildContext({ role: 'ADMN' }))).toBe(false)
		})
	})
})
