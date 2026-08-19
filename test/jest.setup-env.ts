/**
 * Unit tests must not depend on a local `.env`. Anything imported through
 * `src/common/constants` validates the environment at module load, so fill in placeholders for
 * every required variable before the first import runs.
 */

// Jest sets NODE_ENV to `test`, which the env schema does not accept.
process.env.NODE_ENV = 'development'
process.env.LOG_LEVEL = 'error'

/** Values already provided (by CI, or on the command line) win. */
const defaults: Record<string, string> = {
	PORT: '3000',
	DATABASE_URL: 'mongodb://localhost:27017/fillando-test',
	FRONTEND_URL: 'http://localhost:9000',
	GOOGLE_CLIENT_ID: 'test-google-client-id',
	GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
	GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
	JWT_SECRET: 'test-jwt-secret',
	JWT_EXPIRATION: '15',
	ACCSESS_TOKEN_NAME: 'access_token',
	REFRESH_JWT_SECRET: 'test-refresh-jwt-secret',
	REFRESH_JWT_EXPIRATION: '10080',
	REFRESH_TOKEN_NAME: 'refresh_token',
	PASSWORD_PEPPER: 'test-password-pepper-16',
	PROM_API_KEY: 'test-prom-api-key'
}

for (const [key, value] of Object.entries(defaults)) {
	process.env[key] ??= value
}
