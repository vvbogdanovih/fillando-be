import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Profile, Strategy } from 'passport-google-oauth20'
import { ENV } from 'src/common/constants'

/** What `validate` puts on `req.user` after the Google callback (`AuthService.googleLogin`). */
export type GoogleUser = {
	email: string | undefined
	name: string
	picture: string | undefined
	provider: 'google'
	providerId: string
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
	constructor() {
		super({
			clientID: ENV.GOOGLE_CLIENT_ID,
			clientSecret: ENV.GOOGLE_CLIENT_SECRET,
			callbackURL: ENV.GOOGLE_CALLBACK_URL,
			scope: ['email', 'profile']
		})
	}

	validate(_accessToken: string, _refreshToken: string, profile: Profile): GoogleUser {
		const { name, emails, photos, id } = profile

		return {
			email: emails?.[0]?.value,
			name: `${name?.givenName} ${name?.familyName}`,
			picture: photos?.[0]?.value,
			provider: 'google',
			providerId: id
		}
	}
}
