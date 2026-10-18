import { UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Types } from 'mongoose'
import { ENV, REFRESH_REUSE_GRACE_MS } from 'src/common/constants'
import { Role } from 'src/common/types/enums'
import { AuthService } from './auth.service'

/**
 * Refresh rotation with a reuse window. The scenario that matters is two browser tabs sending
 * the same refresh cookie within milliseconds of each other: with a strictly single-use token
 * the second one got 401, logged out, and that logout revoked the first tab's new token — one
 * race ended every tab's session. Inside `REFRESH_REUSE_GRACE_MS` a reuse is served; outside it
 * the token is treated as stolen.
 */
type Stored = {
	_id: Types.ObjectId
	token: string
	userId: Types.ObjectId
	expiresAt: Date
	usedAt?: Date
}

const payload = { id: 'u1', email: 'u1@test.invalid', name: 'Test', role: Role.USER }

describe('AuthService.refresh', () => {
	let jwt: JwtService
	let repo: {
		findByTokenHash: jest.Mock
		deleteById: jest.Mock
		markUsed: jest.Mock
		deleteExpiredForUser: jest.Mock
		create: jest.Mock
	}
	let service: AuthService

	const stored = (overrides: Partial<Stored> = {}): Stored => ({
		_id: new Types.ObjectId(),
		token: 'hash',
		userId: new Types.ObjectId(),
		expiresAt: new Date(Date.now() + 60_000),
		...overrides
	})

	beforeEach(() => {
		jwt = new JwtService({})
		repo = {
			findByTokenHash: jest.fn(),
			deleteById: jest.fn().mockResolvedValue(undefined),
			markUsed: jest.fn().mockResolvedValue(undefined),
			deleteExpiredForUser: jest.fn().mockResolvedValue(undefined),
			create: jest.fn().mockResolvedValue({})
		}
		service = new AuthService(jwt, {} as never, repo as never)
	})

	const validToken = () => service.issueRefreshToken(payload)

	it('issues distinct refresh tokens for the same user in the same second (jti)', () => {
		const a = service.issueRefreshToken(payload)
		const b = service.issueRefreshToken(payload)
		expect(a).not.toBe(b)
		expect(jwt.decode(a)).toHaveProperty('jti')
	})

	it('rejects a missing token', async () => {
		await expect(service.refresh('')).rejects.toThrow(UnauthorizedException)
		expect(repo.findByTokenHash).not.toHaveBeenCalled()
	})

	it('rejects a token that is not in the store', async () => {
		repo.findByTokenHash.mockResolvedValue(null)
		await expect(service.refresh(validToken())).rejects.toThrow(UnauthorizedException)
	})

	it('rejects and deletes an expired token', async () => {
		const rec = stored({ expiresAt: new Date(Date.now() - 1) })
		repo.findByTokenHash.mockResolvedValue(rec)
		await expect(service.refresh(validToken())).rejects.toThrow(UnauthorizedException)
		expect(repo.deleteById).toHaveBeenCalledWith(rec._id)
		expect(repo.create).not.toHaveBeenCalled()
	})

	it('first use: marks the token consumed and issues a new pair', async () => {
		const rec = stored()
		repo.findByTokenHash.mockResolvedValue(rec)

		const out = await service.refresh(validToken(), { ipAddress: '1.1.1.1' })

		expect(repo.markUsed).toHaveBeenCalledWith(rec._id, expect.any(Date))
		expect(repo.deleteById).not.toHaveBeenCalled()
		expect(repo.create).toHaveBeenCalledTimes(1)
		expect(jwt.verify(out.access_token, { secret: ENV.JWT_SECRET })).toMatchObject({ id: 'u1' })
		expect(jwt.verify(out.refresh_token, { secret: ENV.REFRESH_JWT_SECRET })).toMatchObject({
			id: 'u1'
		})
	})

	it('reuse inside the grace window: serves a fresh pair without touching the record', async () => {
		const rec = stored({ usedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS / 2) })
		repo.findByTokenHash.mockResolvedValue(rec)

		const out = await service.refresh(validToken())

		expect(repo.markUsed).not.toHaveBeenCalled()
		expect(repo.deleteById).not.toHaveBeenCalled()
		expect(repo.create).toHaveBeenCalledTimes(1)
		expect(out.refresh_token).toBeTruthy()
	})

	it('two tabs racing one cookie both get a pair, and the pairs differ', async () => {
		const rec = stored()
		const token = validToken()
		// The second call sees the record the first one just marked used.
		repo.findByTokenHash
			.mockResolvedValueOnce(rec)
			.mockResolvedValueOnce({ ...rec, usedAt: new Date() })

		const [a, b] = await Promise.all([service.refresh(token), service.refresh(token)])

		expect(a.refresh_token).not.toBe(b.refresh_token)
		expect(repo.create).toHaveBeenCalledTimes(2)
		expect(repo.deleteById).not.toHaveBeenCalled()
	})

	it('reuse after the grace window: rejects and deletes the token (stolen)', async () => {
		const rec = stored({ usedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1) })
		repo.findByTokenHash.mockResolvedValue(rec)

		await expect(service.refresh(validToken())).rejects.toThrow(UnauthorizedException)
		expect(repo.deleteById).toHaveBeenCalledWith(rec._id)
		expect(repo.create).not.toHaveBeenCalled()
	})

	it('rejects a stored token whose signature does not verify', async () => {
		repo.findByTokenHash.mockResolvedValue(stored())
		const forged = new JwtService({}).sign(payload, { secret: 'other-secret' })
		await expect(service.refresh(forged)).rejects.toThrow(UnauthorizedException)
		expect(repo.create).not.toHaveBeenCalled()
	})
})
