import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
	API_OPERATION,
	ENDPOINTS,
	ENV,
	RefreshTokenLifetime
} from 'src/common/constants'
import { AuthService } from './auth.service'
import { PinoLogger } from 'nestjs-pino'
import { AuthGuard } from '@nestjs/passport'
import type { Request, Response } from 'express'
import UAParser from 'ua-parser-js'
import { LoginDto } from './dto/login.dto'
import { RegisterDto } from './dto/register.dto'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'

@Controller(ENDPOINTS.AUTH.BASE)
@ApiTags(ENDPOINTS.AUTH.BASE)
export class AuthController {
	constructor(
		private authService: AuthService,
		private readonly logger: PinoLogger
	) {
		this.logger.setContext(AuthController.name)
	}

	private setJwtCookie(res: Response, token: string) {
		res.cookie(ENV.ACCSESS_TOKEN_NAME, token, {
			httpOnly: true,
			secure: false,
			sameSite: 'lax',
			maxAge: RefreshTokenLifetime.ms
		})
	}

	private setRefreshCookie(res: Response, refreshToken: string) {
		res.cookie(ENV.REFRESH_TOKEN_NAME, refreshToken, {
			httpOnly: true,
			secure: false,
			sameSite: 'strict',
			maxAge: RefreshTokenLifetime.ms
		})
	}

	private formatUserAgent(raw: string | undefined): string | undefined {
		if (!raw) return undefined

		const parsed = new (UAParser as any)(raw).getResult()
		const browser =
			parsed.browser.name && parsed.browser.version
				? `${parsed.browser.name} ${parsed.browser.version}`
				: null
		const os =
			parsed.os.name && parsed.os.version
				? `${parsed.os.name} ${parsed.os.version}`
				: (parsed.os.name ?? null)
		const parts = [browser, os].filter(Boolean)

		return parts.length > 0 ? parts.join(' / ') : raw
	}

	private getClientContext(req: Request): { ipAddress?: string; userAgent?: string } {
		const forwarded = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
		const realIp = req.headers['x-real-ip'] as string | undefined
		const rawIp = req.ip || req.socket?.remoteAddress
		const ip = forwarded || realIp || rawIp
		const normalized = ip === '::1' ? '127.0.0.1' : ip
		const rawUserAgent = req.get('User-Agent')
		const userAgent = this.formatUserAgent(rawUserAgent ?? undefined)
		return { ipAddress: normalized, userAgent }
	}

	@Post(ENDPOINTS.AUTH.LOGIN)
	@ApiOperation(API_OPERATION.AUTH.LOGIN)
	async login(
		@Body() loginDto: LoginDto,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		const { access_token, refresh_token, user } = await this.authService.login(
			loginDto,
			this.getClientContext(req)
		)

		this.setJwtCookie(res, access_token)
		this.setRefreshCookie(res, refresh_token)

		return { message: 'Login successful', user: user }
	}

	@Post(ENDPOINTS.AUTH.REGISTER)
	@ApiOperation(API_OPERATION.AUTH.REGISTER)
	async register(
		@Body() registerDto: RegisterDto,
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		const { access_token, refresh_token, user } = await this.authService.register(
			registerDto,
			this.getClientContext(req)
		)

		this.setJwtCookie(res, access_token)
		this.setRefreshCookie(res, refresh_token)

		return { message: 'Registration successful', user: user }
	}

	@Get(ENDPOINTS.AUTH.GOOGLE)
	@UseGuards(AuthGuard('google'))
	@ApiOperation(API_OPERATION.AUTH.GOOGLE)
	async googleLogin() {}

	@Get(ENDPOINTS.AUTH.GOOGLE_CALLBACK)
	@UseGuards(AuthGuard('google'))
	@ApiOperation(API_OPERATION.AUTH.GOOGLE_CALLBACK)
	async googleAuthRedirect(@Req() req: Request, @Res() res: Response) {
		const tokens = await this.authService.googleLogin(req.user, this.getClientContext(req))

		this.setJwtCookie(res, tokens.access_token)
		this.setRefreshCookie(res, tokens.refresh_token)

		return res.redirect(ENV.FRONTEND_URL + '/auth/success')
	}

	@Post(ENDPOINTS.AUTH.LOGOUT)
	@ApiOperation(API_OPERATION.AUTH.LOGOUT)
	async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const refreshToken = req.cookies?.[ENV.REFRESH_TOKEN_NAME]
		await this.authService.logout(refreshToken)

		res.clearCookie(ENV.ACCSESS_TOKEN_NAME)
		res.clearCookie(ENV.REFRESH_TOKEN_NAME)

		return { message: 'Logout successful' }
	}

	@Post(ENDPOINTS.AUTH.REFRESH)
	@ApiOperation(API_OPERATION.AUTH.REFRESH)
	async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const refreshToken = req.cookies?.[ENV.REFRESH_TOKEN_NAME]
		const tokens = await this.authService.refresh(refreshToken, this.getClientContext(req))

		this.setJwtCookie(res, tokens.access_token)
		this.setRefreshCookie(res, tokens.refresh_token)

		return { message: 'Refresh successful' }
	}

	@Get(ENDPOINTS.AUTH.ME)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.AUTH.ME)
	async me(@Req() req: Request) {
		const user = await this.authService.getMe(req.user)
		return { message: 'Me successful', user: user }
	}
}
