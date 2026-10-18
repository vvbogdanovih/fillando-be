import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard'

/**
 * The guard's contract is "cookie optional, validity not": no access cookie → guest (`null`),
 * an access cookie that failed verification → 401. The 401 is what lets the storefront's
 * 401-only refresh path run; the old guard answered 200 `{ user: null }` for an expired JWT, so
 * a reloaded tab looked logged out while its refresh cookie was still valid.
 */
const contextWithCookies = (cookies: Record<string, string> | undefined): ExecutionContext =>
	({
		switchToHttp: () => ({ getRequest: () => ({ cookies }) })
	}) as unknown as ExecutionContext

describe('OptionalJwtAuthGuard.handleRequest', () => {
	const guard = new OptionalJwtAuthGuard()
	const user = { id: 'u1', role: 'USER' }

	it('returns the user when passport verified a token', () => {
		expect(guard.handleRequest(null, user, undefined, contextWithCookies({}))).toBe(user)
	})

	it('answers null (a guest) when there is no access cookie at all', () => {
		expect(
			guard.handleRequest(null, false, undefined, contextWithCookies(undefined))
		).toBeNull()
		expect(guard.handleRequest(null, false, undefined, contextWithCookies({}))).toBeNull()
	})

	it('throws 401 when an access cookie is present but did not verify (expired / bad signature)', () => {
		const ctx = contextWithCookies({ [ENV.ACCSESS_TOKEN_NAME]: 'expired.jwt.value' })
		expect(() => guard.handleRequest(null, false, undefined, ctx)).toThrow(
			UnauthorizedException
		)
	})

	it('rethrows errors that are not authentication failures', () => {
		const boom = new Error('db down')
		expect(() => guard.handleRequest(boom, false, undefined, contextWithCookies({}))).toThrow(
			boom
		)
	})
})
