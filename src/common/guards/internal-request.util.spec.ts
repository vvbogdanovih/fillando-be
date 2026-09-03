import { ExecutionContext } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { INTERNAL_TOKEN_HEADER, isInternalRequest } from './internal-request.util'

const ctxWith = (headers: Record<string, unknown>) =>
	({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext

describe('isInternalRequest', () => {
	const token = ENV.INTERNAL_API_TOKEN as string

	it('is true only for the exact configured token', () => {
		expect(isInternalRequest(ctxWith({ [INTERNAL_TOKEN_HEADER]: token }))).toBe(true)
	})

	it.each([
		['missing header', {}],
		['wrong token of the same length', { [INTERNAL_TOKEN_HEADER]: 'x'.repeat(token.length) }],
		['token of a different length', { [INTERNAL_TOKEN_HEADER]: token.slice(1) }],
		['empty string', { [INTERNAL_TOKEN_HEADER]: '' }],
		['array header', { [INTERNAL_TOKEN_HEADER]: ['a', 'b'] }],
		['non-string header', { [INTERNAL_TOKEN_HEADER]: 42 }]
	])('is false for %s and never throws', (_label, headers) => {
		expect(() => isInternalRequest(ctxWith(headers))).not.toThrow()
		expect(isInternalRequest(ctxWith(headers))).toBe(false)
	})

	it('exempts nothing when no token is configured', () => {
		const spy = jest.replaceProperty(
			ENV as { INTERNAL_API_TOKEN?: string },
			'INTERNAL_API_TOKEN',
			undefined
		)
		try {
			expect(isInternalRequest(ctxWith({ [INTERNAL_TOKEN_HEADER]: token }))).toBe(false)
		} finally {
			spy.restore()
		}
	})
})
