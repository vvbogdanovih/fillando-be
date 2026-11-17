import http, { Agent, type Server } from 'node:http'
import { NestApplication } from '@nestjs/core'

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

// Integration HTTP (Plan-0010 D06.6). supertest gives a server that is not listening `listen(0)`
// — the wildcard address — and then connects to 127.0.0.1. On macOS a wildcard listener may be
// handed a port another process on the machine already listens on at 127.0.0.1, and that process
// gets the request: an empty 404, a 401, «socket hang up», a request that never ends. So every
// Nest test application listens on 127.0.0.1 once `init()` resolves (the OS never hands out a port
// taken there) and supertest only reuses it; the suite's `app.close()` closes it. A spec that calls
// `listen()` itself gets exactly the address it asked for.
type TestApp = NestApplication & { testBound?: boolean; testListen?: boolean }
const serverOf = (app: TestApp) => app.getHttpServer() as Server
// The prototype's own methods, called below with the application as `this`.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { init, listen } = NestApplication.prototype
NestApplication.prototype.init = async function (this: TestApp): Promise<TestApp> {
	await init.call(this)
	const server = serverOf(this)
	if (!this.testListen && !server.listening) {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		this.testBound = true
	}
	return this
}
NestApplication.prototype.listen = async function (this: TestApp, ...args: unknown[]) {
	this.testListen = true
	if (this.testBound) await new Promise<void>(resolve => serverOf(this).close(() => resolve()))
	return (listen as (...a: unknown[]) => Promise<unknown>).apply(this, args) as Promise<Server>
} as typeof listen
// And one connection per request: since Node 19 the global agent — shared by every suite of a
// `--runInBand` process through the built-in `http` module — keeps sockets alive, and a pooled
// socket to a port a closed server used still reaches that closed application.
http.globalAgent = new Agent({ keepAlive: false })
