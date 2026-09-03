import { z } from 'zod'
import { fromZodError } from 'zod-validation-error'
import 'dotenv/config'

const envSchema = z.object({
	DATABASE_URL: z.string().min(1),

	GOOGLE_CLIENT_ID: z.string().min(1),
	GOOGLE_CLIENT_SECRET: z.string().min(1),
	GOOGLE_CALLBACK_URL: z.string().min(1),

	JWT_SECRET: z.string().min(10),
	JWT_EXPIRATION: z.coerce.number(),
	ACCSESS_TOKEN_NAME: z.string().min(1),

	REFRESH_JWT_SECRET: z.string().min(10),
	REFRESH_JWT_EXPIRATION: z.coerce.number(),
	REFRESH_TOKEN_NAME: z.string().min(1),

	PASSWORD_PEPPER: z.string().min(16),

	AWS_REGION: z.string().min(1),
	AWS_ACCESS_KEY_ID: z.string().min(1),
	AWS_SECRET_ACCESS_KEY: z.string().min(1),
	AWS_S3_BUCKET_NAME: z.string().min(1),
	AWS_S3_PUBLIC_URL: z.string().url(),

	NOVA_POS_API_KEY: z.string().min(1),

	PROM_API_KEY: z.string().min(1),

	RESEND_API_KEY: z.string().min(1),
	SERVICE_EMAIL: z.string().email(),
	ALLOW_EMAIL_SENDING: z.coerce.boolean().default(true),

	// Secret used to derive the AES-256-GCM key (via SHA-256) that encrypts payment
	// provider secrets (e.g. LiqPay/MonoPay private keys) at rest in MongoDB.
	PAYMENT_ENCRYPTION_KEY: z.string().min(32),
	// Publicly reachable base URL of this backend, used to build the LiqPay
	// `server_url` callback (e.g. https://fillando.com/api). Falls back to FRONTEND-less usage.
	PUBLIC_API_URL: z.string().url(),

	FRONTEND_URL: z.string().min(1),
	PORT: z.coerce.number(),

	NODE_ENV: z.enum(['development', 'production']).default('development'),
	LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

	// Enables in-process scheduled jobs (e.g. Prom availability sync). Keep `true`
	// on a single instance only when running multiple replicas. Defaults to off.
	RUN_CRON: z
		.string()
		.optional()
		.transform(v => v === 'true' || v === '1'),
	// Shared secret the frontend's server-side fetches send as `X-Internal-Token`; requests
	// carrying it bypass the rate limiter. Optional — when unset nothing is exempted.
	INTERNAL_API_TOKEN: z.string().min(32).optional()
})

type EnvSchema = z.infer<typeof envSchema>

const getParsedEnv = (): EnvSchema => {
	const result = envSchema.safeParse({
		DATABASE_URL: process.env.DATABASE_URL,
		GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
		GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
		GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL,
		JWT_SECRET: process.env.JWT_SECRET,
		JWT_EXPIRATION: process.env.JWT_EXPIRATION,
		ACCSESS_TOKEN_NAME: process.env.ACCSESS_TOKEN_NAME,
		REFRESH_JWT_SECRET: process.env.REFRESH_JWT_SECRET,
		REFRESH_JWT_EXPIRATION: process.env.REFRESH_JWT_EXPIRATION,
		REFRESH_TOKEN_NAME: process.env.REFRESH_TOKEN_NAME,
		PASSWORD_PEPPER: process.env.PASSWORD_PEPPER,
		AWS_REGION: process.env.AWS_REGION,
		AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
		AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME,
		AWS_S3_PUBLIC_URL: process.env.AWS_S3_PUBLIC_URL,
		NOVA_POS_API_KEY: process.env.NOVA_POS_API_KEY,
		PROM_API_KEY: process.env.PROM_API_KEY,
		RESEND_API_KEY: process.env.RESEND_API_KEY,
		SERVICE_EMAIL: process.env.SERVICE_EMAIL,
		ALLOW_EMAIL_SENDING: process.env.ALLOW_EMAIL_SENDING,
		PAYMENT_ENCRYPTION_KEY: process.env.PAYMENT_ENCRYPTION_KEY,
		PUBLIC_API_URL: process.env.PUBLIC_API_URL,
		FRONTEND_URL: process.env.FRONTEND_URL,
		PORT: process.env.PORT,
		NODE_ENV: process.env.NODE_ENV,
		LOG_LEVEL: process.env.LOG_LEVEL,
		RUN_CRON: process.env.RUN_CRON,
		INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN
	})
	if (!result.success) {
		console.log('error', result.error)
		throw new Error(fromZodError(result.error).toString())
	}
	return result.data
}

const validatedEnv = getParsedEnv()

export const ENV = {
	DATABASE_URL: validatedEnv.DATABASE_URL,
	GOOGLE_CLIENT_ID: validatedEnv.GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET: validatedEnv.GOOGLE_CLIENT_SECRET,
	GOOGLE_CALLBACK_URL: validatedEnv.GOOGLE_CALLBACK_URL,
	JWT_SECRET: validatedEnv.JWT_SECRET,
	JWT_EXPIRATION: validatedEnv.JWT_EXPIRATION,
	ACCSESS_TOKEN_NAME: validatedEnv.ACCSESS_TOKEN_NAME,
	REFRESH_JWT_SECRET: validatedEnv.REFRESH_JWT_SECRET,
	REFRESH_JWT_EXPIRATION: validatedEnv.REFRESH_JWT_EXPIRATION,
	REFRESH_TOKEN_NAME: validatedEnv.REFRESH_TOKEN_NAME,
	PASSWORD_PEPPER: validatedEnv.PASSWORD_PEPPER,
	AWS_REGION: validatedEnv.AWS_REGION,
	AWS_ACCESS_KEY_ID: validatedEnv.AWS_ACCESS_KEY_ID,
	AWS_SECRET_ACCESS_KEY: validatedEnv.AWS_SECRET_ACCESS_KEY,
	AWS_S3_BUCKET_NAME: validatedEnv.AWS_S3_BUCKET_NAME,
	AWS_S3_PUBLIC_URL: validatedEnv.AWS_S3_PUBLIC_URL,
	NOVA_POS_API_KEY: validatedEnv.NOVA_POS_API_KEY,
	PROM_API_KEY: validatedEnv.PROM_API_KEY,
	RESEND_API_KEY: validatedEnv.RESEND_API_KEY,
	SERVICE_EMAIL: validatedEnv.SERVICE_EMAIL,
	ALLOW_EMAIL_SENDING: validatedEnv.ALLOW_EMAIL_SENDING,
	PAYMENT_ENCRYPTION_KEY: validatedEnv.PAYMENT_ENCRYPTION_KEY,
	PUBLIC_API_URL: validatedEnv.PUBLIC_API_URL,
	FRONTEND_URL: validatedEnv.FRONTEND_URL,
	PORT: validatedEnv.PORT,
	NODE_ENV: validatedEnv.NODE_ENV,
	LOG_LEVEL: validatedEnv.LOG_LEVEL,
	RUN_CRON: validatedEnv.RUN_CRON,
	INTERNAL_API_TOKEN: validatedEnv.INTERNAL_API_TOKEN
} as const
