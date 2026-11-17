import {
	Body,
	Controller,
	Get,
	Post,
	Req,
	Res,
	UnauthorizedException,
	UseGuards
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS, ENV, RefreshTokenLifetime } from 'src/common/constants'
import { AuthService } from './auth.service'
import { PinoLogger } from 'nestjs-pino'
import { AuthGuard } from '@nestjs/passport'
import type { Request, Response } from 'express'
import { UAParser } from 'ua-parser-js'
import { LoginDto } from './dto/login.dto'
import { RegisterDto } from './dto/register.dto'
import { clientIp } from 'src/common/guards/client-ip.util'
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard'
import type { GoogleUser } from 'src/common/strategies/google.strategy'
import { JWTPayload } from 'src/common/types/jwt-payload'

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

		const parsed = new UAParser(raw).getResult()
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

	/**
	 * The refresh token from its cookie — only a string. cookie-parser decodes a `j:`-prefixed
	 * cookie as JSON, and such an object used to reach the token hash and answer 500 on refresh
	 * (cookies kept) and logout (P19); it is no token: refresh is a 401 that clears both cookies,
	 * logout a plain logout.
	 */
	private refreshCookie(req: Request): string | undefined {
		const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
			ENV.REFRESH_TOKEN_NAME
		]
		return typeof token === 'string' ? token : undefined
	}

	private getClientContext(req: Request): { ipAddress?: string; userAgent?: string } {
		// The visitor, not a header the client wrote (P11): `X-Forwarded-For` and `X-Real-IP` were.
		const ip = clientIp(req)
		const normalized = ip === '::1' ? '127.0.0.1' : ip
		const rawUserAgent = req.get('User-Agent')
		const userAgent = this.formatUserAgent(rawUserAgent ?? undefined)
		return { ipAddress: normalized, userAgent }
	}

	@Post(ENDPOINTS.AUTH.LOGIN)
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
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
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
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
		// `GoogleStrategy.validate` put it there.
		const tokens = await this.authService.googleLogin(
			req.user as GoogleUser,
			this.getClientContext(req)
		)

		this.setJwtCookie(res, tokens.access_token)
		this.setRefreshCookie(res, tokens.refresh_token)

		return res.redirect(ENV.FRONTEND_URL + '/auth/success')
	}

	@Post(ENDPOINTS.AUTH.LOGOUT)
	@ApiOperation(API_OPERATION.AUTH.LOGOUT)
	async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const refreshToken = this.refreshCookie(req)
		await this.authService.logout(refreshToken)

		res.clearCookie(ENV.ACCSESS_TOKEN_NAME)
		res.clearCookie(ENV.REFRESH_TOKEN_NAME)

		return { message: 'Logout successful' }
	}

	@Post(ENDPOINTS.AUTH.REFRESH)
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.AUTH.REFRESH)
	async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const refreshToken = this.refreshCookie(req)
		let tokens: { access_token: string; refresh_token: string }
		try {
			tokens = await this.authService.refresh(refreshToken, this.getClientContext(req))
		} catch (error) {
			// A rejected refresh means the cookies in the jar cannot open a session any more, so
			// drop them here. The storefront used to do this by calling `POST /auth/logout`, and
			// that call carried whatever cookie the jar held at the time — in a two-tab race, the
			// other tab's freshly rotated token, which the logout then revoked for everyone.
			if (error instanceof UnauthorizedException) {
				res.clearCookie(ENV.ACCSESS_TOKEN_NAME)
				res.clearCookie(ENV.REFRESH_TOKEN_NAME)
			}
			throw error
		}

		this.setJwtCookie(res, tokens.access_token)
		this.setRefreshCookie(res, tokens.refresh_token)

		return { message: 'Refresh successful' }
	}

	@Get(ENDPOINTS.AUTH.ME)
	@UseGuards(OptionalJwtAuthGuard)
	@ApiOperation(API_OPERATION.AUTH.ME)
	async me(@Req() req: Request) {
		if (!req.user) {
			return { message: 'Not authenticated', user: null }
		}
		// `JwtStrategy.validate` put it there.
		const user = await this.authService.getMe(req.user as JWTPayload)
		return { message: 'Me successful', user: user }
	}
}
