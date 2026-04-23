import { ENV } from './env.constant'

export const AccessTokenLifetime = {
	ms: ENV.JWT_EXPIRATION * 60 * 1000,
	sec: ENV.JWT_EXPIRATION * 60
}

export const RefreshTokenLifetime = {
	ms: ENV.REFRESH_JWT_EXPIRATION * 60 * 1000,
	sec: ENV.REFRESH_JWT_EXPIRATION * 60
}
