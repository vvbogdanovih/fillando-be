import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import {
	CatalogMutationJournal,
	type CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import {
	CatalogWriteGate,
	type CatalogWriteToken
} from 'src/database/mongoose/repositories/catalog-write-gate'
import { TEST_MONGO_URL } from '../../../test/integration-db'

/**
 * The operator recovery of an interrupted new-admin write (TD-0013 §3, Plan-0010 audit
 * 31.10.2026): `scripts/catalog-recover.cjs` in its production mode, end to end as a child
 * process, against the disposable test MongoDB standing in for production (loopback only).
 */
const origin = new URL(TEST_MONGO_URL)
const uri = `mongodb://${origin.host}`
const root = path.join(__dirname, '../../..')
const run = promisify(execFile)
const id = (n: number) => n.toString(16).padStart(24, '0')
const marker = new ObjectId(id(99))
let client: MongoClient
let db: Db
let gate: CatalogWriteGate
let journal: CatalogMutationJournal

async function recover(...args: string[]) {
	try {
		const { stdout, stderr } = await run('node', ['scripts/catalog-recover.cjs', ...args], {
			cwd: root,
			env: { ...process.env, DATABASE_URL: uri },
			timeout: 60_000
		})
		return { code: 0, stdout, stderr }
	} catch (error) {
		const failed = error as { code?: number; stdout: string; stderr: string }
		return { code: failed.code ?? 1, stdout: failed.stdout, stderr: failed.stderr }
	}
}
const write = (command: string, operation: string, ...flags: string[]) =>
	recover(
		command,
		'fillando-prod',
		operation,
		'--production',
		'--writers-stopped',
		`--confirm=${command}:fillando-prod:${operation}`,
		...flags
	)
const control = () => db.collection<{ _id: string }>('catalog_control').findOne({ _id: 'catalog' })
const marked = () => db.collection('product_variants').countDocuments({ category_id: marker })
const patches = (): CatalogPatch[] =>
	[1, 2].map(n => ({
		collection: 'product_variants',
		id: id(n),
		fields: {
			category_id: { before: { exists: false }, after: { exists: true, value: marker } }
		}
	}))

/** A save that stored its plan, wrote one of two targets and then lost its process. */
async function interrupted(operation: string): Promise<CatalogWriteToken> {
	const { revision } = await gate.readStamp()
	const token = await gate.acquire(operation, `hash-${operation}`, `api-${operation}`, revision)
	await journal.prepare(token, patches())
	await gate.beginDomainWrites(token)
	await db
		.collection('product_variants')
		.updateOne({ _id: new ObjectId(id(1)) }, { $set: { category_id: marker } })
	return token
}

beforeAll(async () => {
	if (!['127.0.0.1', 'localhost'].includes(origin.hostname))
		throw Error('This suite creates a database named fillando-prod; loopback test Mongo only')
	client = await new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect()
	db = client.db('fillando-prod')
}, 30_000)
beforeEach(async () => {
	await db.dropDatabase()
	gate = new CatalogWriteGate(db)
	journal = new CatalogMutationJournal(db, gate)
	await gate.initialize()
	await db
		.collection('product_variants')
		.insertMany([1, 2].map(n => ({ _id: new ObjectId(id(n)), price: 100, stock: 2 })))
})
afterAll(async () => {
	await db?.dropDatabase()
	await client?.close()
})

describe('catalog-recover.cjs (production mode)', () => {
	it('inspects the closed catalogue without the owner token and without writing', async () => {
		await interrupted('save-1')
		const result = await recover('inspect', 'fillando-prod', '--production')
		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toEqual({
			control: expect.objectContaining({
				phase: 'writing',
				operation_id: 'save-1',
				writes_started: true
			}) as object,
			operation: 'save-1',
			status: 'claimed',
			journal: {
				phase: 'prepared',
				targets: 2,
				counts: { before: 1, after: 1, both: 0, conflict: 0, missing: 0 }
			}
		})
		expect(result.stdout).not.toContain('api-save-1')
		expect(JSON.parse(result.stderr)).toMatchObject({
			target: { mode: 'production', database: 'fillando-prod', hosts: [origin.host] }
		})
		expect(await control()).toMatchObject({ phase: 'writing' })
	}, 60_000)

	it('refuses a write without stopped writers or the typed confirmation', async () => {
		await interrupted('save-2')
		const unconfirmed = await recover(
			'rollback',
			'fillando-prod',
			'save-2',
			'--production',
			'--writers-stopped'
		)
		expect(unconfirmed.code).toBe(1)
		expect(unconfirmed.stderr).toContain('--confirm=')
		const running = await recover(
			'rollback',
			'fillando-prod',
			'save-2',
			'--production',
			'--confirm=rollback:fillando-prod:save-2'
		)
		expect(running.code).toBe(1)
		expect(running.stderr).toContain('--writers-stopped')
		expect(await control()).toMatchObject({ phase: 'writing', operation_id: 'save-2' })
	}, 60_000)

	it('rolls an interrupted save back to its before-image and reopens the catalogue', async () => {
		await interrupted('save-3')
		const result = await write('rollback', 'save-3')
		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({
			operation: 'save-3',
			status: 'rolled_back',
			targets: 2,
			control: { phase: 'idle', revision: 0 }
		})
		expect(await marked()).toBe(0)
		expect(await gate.operation('save-3')).toMatchObject({ status: 'rolled_back' })
		expect(await gate.readStamp()).toMatchObject({ revision: 0 })
		// Repeating it reports the finished operation instead of touching anything.
		const again = await write('rollback', 'save-3')
		expect(JSON.parse(again.stdout)).toMatchObject({
			status: 'rolled_back',
			already_finished: true
		})
	}, 60_000)

	it('resumes a save the writer marked recovery_required and publishes it', async () => {
		const token = await interrupted('save-4')
		await gate.afterFailedWrite(token, true)
		expect(await control()).toMatchObject({ phase: 'recovery_required' })
		const result = await write('resume', 'save-4')
		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({
			status: 'completed',
			control: { phase: 'idle', revision: 1 }
		})
		expect(await marked()).toBe(2)
		expect(await gate.operation('save-4')).toMatchObject({ status: 'completed', revision: 1 })
	}, 60_000)

	it('releases the gate when nothing was written, and never touches a migration run', async () => {
		const { revision } = await gate.readStamp()
		const token = await gate.acquire('save-5', 'hash', 'api', revision)
		await journal.prepare(token, patches())
		const released = await write('resume', 'save-5')
		expect(JSON.parse(released.stdout)).toEqual({
			operation: 'save-5',
			status: 'aborted_before_writes'
		})
		expect(await marked()).toBe(0)
		expect(await control()).toMatchObject({ phase: 'idle' })

		await interrupted('filament-v2')
		await db.collection<{ _id: string }>('catalog_stage_runs').insertOne({ _id: 'filament-v2' })
		const migration = await write('rollback', 'filament-v2')
		expect(migration.code).toBe(1)
		expect(migration.stderr).toContain('catalog-v2-migrate.cjs')
		expect(await control()).toMatchObject({ phase: 'writing', operation_id: 'filament-v2' })
	}, 60_000)
})
