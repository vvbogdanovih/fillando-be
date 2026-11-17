import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import type { Request } from 'express'
import { Strategy } from 'passport-jwt'
import { ENV } from 'src/common/constants'
import { JWTPayload } from 'src/common/types/jwt-payload'

/**
 * The access JWT from its cookie. cookie-parser decodes a `j:`-prefixed cookie as JSON, so the
 * value need not be a string; anything else is no token, and passport answers 401 exactly as it
 * did when such a value failed verification.
 */
const accessTokenFromCookie = (req: Request): string | null => {
	const token: unknown = req?.cookies?.[ENV.ACCSESS_TOKEN_NAME]
	return typeof token === 'string' ? token : null
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
	constructor() {
		super({
			jwtFromRequest: accessTokenFromCookie,
			secretOrKey: ENV.JWT_SECRET
		})
	}

	validate(payload: JWTPayload): JWTPayload {
		return payload
	}
}
