import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-jwt'
import { ENV } from 'src/common/constants'
import { JWTPayload } from 'src/common/types/jwt-payload'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
	constructor() {
		super({
			jwtFromRequest: req => req?.cookies?.[ENV.ACCSESS_TOKEN_NAME] ?? null,
			secretOrKey: ENV.JWT_SECRET
		})
	}

	async validate(payload: JWTPayload) {
		return payload
	}
}
