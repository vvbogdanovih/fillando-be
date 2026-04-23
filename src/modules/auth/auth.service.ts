import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { RegisterDto } from './dto/register.dto'
import * as argon2 from 'argon2'
import { createHash } from 'node:crypto'
import { LoginDto } from './dto/login.dto'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { AccessTokenLifetime, ENV, RefreshTokenLifetime } from 'src/common/constants'
import { AuthMethod, Role } from 'src/common/types/enums'
import { UserRepository } from 'src/database/mongoose/repositories/user.repository'
import { RefreshTokenRepository } from 'src/database/mongoose/repositories/refresh-token.repository'

@Injectable()
export class AuthService {
	constructor(
		private jwtService: JwtService,
		private userRepository: UserRepository,
		private refreshTokenRepository: RefreshTokenRepository
	) {}

	async getMe(user: any) {
		const found = await this.userRepository.findById(user.id)
		if (!found) throw new UnauthorizedException('Користувача не знайдено')
		return {
			id: found.id,
			email: found.email,
			name: found.name,
			role: found.role,
			picture: found.picture
		}
	}

	async googleLogin(user: any, context?: { ipAddress?: string; userAgent?: string }) {
		let existingUser = await this.userRepository.findByEmail(user.email)

		if (!existingUser) {
			existingUser = await this.userRepository.create({
				name: user.name,
				email: user.email,
				authMethod: AuthMethod.GOOGLE,
				picture: user.picture
			})
		}

		const payload: JWTPayload = {
			id: existingUser.id,
			email: existingUser.email,
			name: existingUser.name,
			role: existingUser.role
		}

		const access_token = this.issueAccessToken(payload)
		const refresh_token = this.issueRefreshToken(payload)
		await this.saveRefreshToken(existingUser.id, refresh_token, context)

		return { access_token, refresh_token }
	}

	async login(user: LoginDto, context?: { ipAddress?: string; userAgent?: string }) {
		const existingUser = await this.userRepository.findByEmail(user.email)
		if (!existingUser) throw new UnauthorizedException('Невірний email або пароль')
		if (!existingUser.password) throw new UnauthorizedException('Невірний email або пароль')

		const isPasswordValid = await argon2.verify(existingUser.password, user.password, {
			secret: Buffer.from(ENV.PASSWORD_PEPPER)
		})

		if (!isPasswordValid) throw new UnauthorizedException('Невірний email або пароль')

		const payload: JWTPayload = {
			id: existingUser.id,
			email: existingUser.email,
			name: existingUser.name,
			role: existingUser.role
		}

		const access_token = this.issueAccessToken(payload)
		const refresh_token = this.issueRefreshToken(payload)
		await this.saveRefreshToken(existingUser.id, refresh_token, context)

		return { access_token, refresh_token, user: { ...payload, picture: existingUser.picture } }
	}

	async register(user: RegisterDto, context?: { ipAddress?: string; userAgent?: string }) {
		const oldUser = await this.userRepository.findByEmail(user.email)
		if (oldUser) throw new ConflictException('Користувач з таким email вже існує')

		if (user.password !== user.confirmPassword)
			throw new ConflictException('Паролі не збігаються')

		const password = await argon2.hash(user.password, {
			secret: Buffer.from(ENV.PASSWORD_PEPPER)
		})
		const newUser = await this.userRepository.create({
			name: user.name,
			email: user.email,
			password
		})

		const payload: JWTPayload = {
			id: newUser.id,
			email: newUser.email,
			name: newUser.name,
			role: newUser.role
		}

		const access_token = this.issueAccessToken(payload)
		const refresh_token = this.issueRefreshToken(payload)
		await this.saveRefreshToken(newUser.id, refresh_token, context)

		return { access_token, refresh_token, user: { ...payload, picture: newUser.picture || '' } }
	}

	issueAccessToken(data: JWTPayload) {
		return this.jwtService.sign(data, {
			secret: ENV.JWT_SECRET,
			expiresIn: AccessTokenLifetime.sec
		})
	}

	issueRefreshToken(data: JWTPayload) {
		return this.jwtService.sign(data, {
			secret: ENV.REFRESH_JWT_SECRET,
			expiresIn: RefreshTokenLifetime.sec
		})
	}

	private hashToken(token: string): string {
		return createHash('sha256').update(token).digest('hex')
	}

	private async saveRefreshToken(
		userId: string,
		token: string,
		context?: { ipAddress?: string; userAgent?: string }
	) {
		await this.refreshTokenRepository.deleteExpiredForUser(userId)

		const expiresAt = new Date(Date.now() + RefreshTokenLifetime.ms)
		await this.refreshTokenRepository.create({
			token: this.hashToken(token),
			userId: userId as any,
			expiresAt,
			ipAddress: context?.ipAddress,
			userAgent: context?.userAgent
		})
	}

	async logout(refreshToken: string | undefined): Promise<void> {
		if (!refreshToken) return
		await this.refreshTokenRepository.deleteByTokenHash(this.hashToken(refreshToken))
	}

	async verifyRefreshToken(token: string) {
		try {
			return await this.jwtService.verifyAsync(token, { secret: ENV.REFRESH_JWT_SECRET })
		} catch {
			throw new UnauthorizedException('Недійсний токен оновлення.')
		}
	}

	async refresh(refreshToken: string, context?: { ipAddress?: string; userAgent?: string }) {
		if (!refreshToken) throw new UnauthorizedException('Refresh token відсутній.')

		const stored = await this.refreshTokenRepository.findByTokenHash(
			this.hashToken(refreshToken)
		)
		if (!stored)
			throw new UnauthorizedException('Refresh token не знайдено або вже використано.')

		if (new Date() > stored.expiresAt) {
			await this.refreshTokenRepository.deleteById(stored._id)
			throw new UnauthorizedException('Refresh token протерміновано.')
		}

		const decoded = await this.verifyRefreshToken(refreshToken)
		await this.refreshTokenRepository.deleteById(stored._id)

		const payload: JWTPayload = {
			id: decoded.id,
			email: decoded.email,
			name: decoded.name,
			role: decoded.role as Role
		}

		const access_token = this.issueAccessToken(payload)
		const new_refresh_token = this.issueRefreshToken(payload)
		await this.saveRefreshToken(stored.userId.toString(), new_refresh_token, context)

		return { access_token, refresh_token: new_refresh_token }
	}
}
