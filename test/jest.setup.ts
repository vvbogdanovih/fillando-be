/**
 * Unit tests import modules that validate the environment at import time
 * (`src/common/constants/env.constant.ts`). Provide safe placeholders so specs
 * run without a real `.env`, and never override values a developer already has.
 */
const defaults: Record<string, string> = {
	DATABASE_URL: 'mongodb://localhost:27017/fillando-test',
	GOOGLE_CLIENT_ID: 'test-google-client-id',
	GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
	GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
	JWT_SECRET: 'test-jwt-secret-value',
	JWT_EXPIRATION: '15',
	ACCSESS_TOKEN_NAME: 'access_token',
	REFRESH_JWT_SECRET: 'test-refresh-secret-value',
	REFRESH_JWT_EXPIRATION: '10080',
	REFRESH_TOKEN_NAME: 'refresh_token',
	PASSWORD_PEPPER: 'test-password-pepper-value',
	AWS_REGION: 'eu-central-1',
	AWS_ACCESS_KEY_ID: 'test-access-key-id',
	AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
	AWS_S3_BUCKET_NAME: 'fillando-test',
	AWS_S3_PUBLIC_URL: 'https://example.invalid',
	NOVA_POS_API_KEY: 'test-nova-post-key',
	PROM_API_KEY: 'test-prom-key',
	RESEND_API_KEY: 'test-resend-key',
	SERVICE_EMAIL: 'service@example.invalid',
	PAYMENT_ENCRYPTION_KEY: 'test-payment-encryption-key-32-chars',
	PUBLIC_API_URL: 'http://localhost:3000',
	FRONTEND_URL: 'http://localhost:9000',
	PORT: '3000',
	INTERNAL_API_TOKEN: 'test-internal-api-token-32-characters-long'
}

for (const [key, value] of Object.entries(defaults)) {
	if (!process.env[key]) process.env[key] = value
}

// Jest sets NODE_ENV=test, which the env schema does not accept.
process.env.NODE_ENV = 'development'
