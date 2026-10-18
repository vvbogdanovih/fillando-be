import { ENV } from './env.constant'

export const AccessTokenLifetime = {
	ms: ENV.JWT_EXPIRATION * 60 * 1000,
	sec: ENV.JWT_EXPIRATION * 60
}

export const RefreshTokenLifetime = {
	ms: ENV.REFRESH_JWT_EXPIRATION * 60 * 1000,
	sec: ENV.REFRESH_JWT_EXPIRATION * 60
}

/**
 * How long a consumed refresh token may still be presented and get a fresh pair instead of 401.
 *
 * Two browser tabs that meet an expired access token at the same moment both send the same
 * refresh cookie; each tab deduplicates its own 401s but knows nothing of the other. With a
 * strictly single-use token the loser got 401, logged out, and that logout carried the winner's
 * brand-new cookie — so one race ended every tab's session. Within this window a reuse is read as
 * that race, not as theft; after it the token is treated as stolen and rejected.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000
