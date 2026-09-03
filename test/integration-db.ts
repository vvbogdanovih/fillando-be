import mongoose from 'mongoose'

/**
 * Connection helper for `*.int-spec.ts` files. Points at the disposable Docker
 * MongoDB from `docker-compose.test.yml` (never at `DATABASE_URL`, which is the
 * shared dev database). Each spec gets its own database name so suites can run
 * in parallel and drop their data on teardown.
 */
export const TEST_MONGO_URL =
	process.env.TEST_DATABASE_URL ?? 'mongodb://127.0.0.1:27018/fillando-test'

export async function connectTestDb(suite: string): Promise<typeof mongoose> {
	const url = new URL(TEST_MONGO_URL)
	url.pathname = `/${url.pathname.replace(/^\//, '') || 'fillando-test'}-${suite}`
	return mongoose.connect(url.toString(), { serverSelectionTimeoutMS: 5000 })
}

export async function dropTestDb(conn: typeof mongoose): Promise<void> {
	await conn.connection.dropDatabase()
	await conn.disconnect()
}
