import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { BSON, MongoClient, ObjectId, type Db } from 'mongodb'
import { TEST_MONGO_URL } from '../../../test/integration-db'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const target = require('../../../scripts/catalog-cli-target.cjs') as {
	MANIFEST_KIND: string
	catalogSnapshot(db: Db, bson: typeof BSON): Promise<unknown>
	sha256File(file: string): Promise<string>
}

/**
 * The release CLIs (Plan-0010 D08 §2) in their production mode, end to end as child processes:
 * the URI from DATABASE_URL (as the backend reads it), the database named `fillando-prod`, typed
 * confirmations, and the restore-checked backup manifest. The disposable test MongoDB stands in
 * for production — guarded to a loopback host, so this suite can never create the database
 * anywhere else.
 */
const origin = new URL(TEST_MONGO_URL)
const uri = `mongodb://${origin.host}`
const root = path.join(__dirname, '../../..')
const run = promisify(execFile)
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'))
const OPERATION = 'filament-v2-test'
let client: MongoClient
let db: Db
let dir: string
let archive: string

async function cli(script: string, args: string[]) {
	const env = { ...process.env, DATABASE_URL: uri }
	try {
		const { stdout, stderr } = await run('node', [`scripts/${script}`, ...args], {
			cwd: root,
			env,
			timeout: 60_000
		})
		return { code: 0, stdout, stderr }
	} catch (error) {
		const failed = error as { code?: number; stdout: string; stderr: string }
		return { code: failed.code ?? 1, stdout: failed.stdout, stderr: failed.stderr }
	}
}
const migrate = (command: string, ...flags: string[]) =>
	cli('catalog-v2-migrate.cjs', [
		command,
		'fillando-prod',
		OPERATION,
		'--production',
		`--mapping=${path.join(dir, 'mapping.json')}`,
		...flags
	])
const writes = (command: string, ...flags: string[]) =>
	cli('catalog-admin-writes.cjs', [command, 'fillando-prod', '--production', ...flags])
type SwitchReport = { result?: string; before: object; after?: object }
const report = (stdout: string) => JSON.parse(stdout) as SwitchReport

async function manifest(name: string, extra: object = {}) {
	const file = path.join(dir, name)
	writeFileSync(
		file,
		JSON.stringify({
			kind: target.MANIFEST_KIND,
			version: 1,
			source_database: 'fillando-prod',
			archive_path: archive,
			archive_name: path.basename(archive),
			archive_bytes: 17,
			archive_sha256: await target.sha256File(archive),
			restored_database: 'fillando_release_check_20261028',
			checked_at: new Date().toISOString(),
			catalog: await target.catalogSnapshot(db, BSON),
			...extra
		})
	)
	return `--backup-manifest=${file}`
}

beforeAll(async () => {
	if (!['127.0.0.1', 'localhost'].includes(origin.hostname))
		throw Error('This suite creates a database named fillando-prod; loopback test Mongo only')
	client = await new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect()
	db = client.db('fillando-prod')
	await db.dropDatabase()
	dir = mkdtempSync(path.join(tmpdir(), 'catalog-release-cli-'))
	archive = path.join(dir, 'fillando-prod-test.archive')
	writeFileSync(archive, 'test archive data')
	writeFileSync(
		path.join(dir, 'mapping.json'),
		JSON.stringify({
			category_slug: 'filament',
			brand_key: null,
			number_keys: ['vaha'],
			drop_product_keys: ['kolir'],
			axis: { key: 'color', label: 'Колір', semantic: 'color' },
			product_name_addition: 'Філамент',
			hidden_keys: ['material', 'vyrobnyk'],
			semantics: { vyrobnyk: 'brand' },
			// The colour axis is required: the single colourless SKU is named (owner, 2026-11-06).
			sku_colors: { 'FL-22': 'White' }
		})
	)
	const field = (key: string, label: string, unit: string | null = null) => ({
		key,
		label,
		is_required: true,
		filter_type: 'multi-select',
		unit
	})
	await db.collection('categories').insertOne({
		_id: id(1),
		name: 'Філамент',
		slug: 'filament',
		required_attributes: [
			field('vyrobnyk', 'Виробник'),
			field('vaha', 'Вага', 'кг'),
			field('polymer', 'Тип пластику')
		]
	})
	await db.collection('colors').insertMany([
		{ _id: id(90), name_uk: 'Чорний', name_en: 'Black', family: 'black' },
		{ _id: id(91), name_uk: 'Білий', name_en: 'White', family: 'white' }
	])
	const attributes = [
		{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
		{ k: 'vaha', l: 'Вага', v: '1' },
		{ k: 'polymer', l: 'Тип пластику', v: 'PLA' },
		{ k: 'material', l: 'Матеріал', v: 'PLA' },
		{ k: 'kolir', l: 'Колір', v: 'Чорний' }
	]
	await db.collection('products').insertMany([
		{
			_id: id(10),
			name: 'Sunlu PLA',
			category_id: id(1),
			attributes,
			variant_type: { key: 'kolir', label: 'Колір' }
		},
		{
			_id: id(11),
			name: 'Sunlu PLA Rainbow',
			category_id: id(1),
			attributes,
			variant_type: null
		}
	])
	const sku = (n: number, product: number, name: string, extra: object) => ({
		_id: id(n),
		product_id: id(product),
		category_id: id(1),
		sku: `FL-${n}`,
		slug: `sku-${n}`,
		name,
		status: 'active',
		price: 500,
		stock: 3,
		...extra
	})
	await db.collection('product_variants').insertMany([
		sku(20, 10, 'Sunlu PLA — Чорний (Black)', {
			color_id: id(90),
			color_family: 'black',
			v_value: 'Black'
		}),
		sku(21, 10, 'Sunlu PLA — Білий (White)', {
			color_id: id(91),
			color_family: 'white',
			v_value: 'White'
		}),
		sku(22, 11, 'Sunlu PLA Rainbow', { v_value: null })
	])
	await db.collection('landings').insertOne({
		_id: id(40),
		category_id: id(1),
		slug: 'pla',
		status: 'active',
		filters: { polymer: ['PLA'] }
	})
}, 30_000)

afterAll(async () => {
	await db?.dropDatabase()
	await client?.close()
})

describe('catalog release CLIs in production mode', () => {
	it('dry-runs without writing anything', async () => {
		const result = await migrate('dry-run')
		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toMatchObject({
			mode: 'dry-run',
			database: 'fillando-prod',
			targets: 7
		})
		// The redacted target goes to stderr, never the URI with credentials.
		expect(JSON.parse(result.stderr)).toMatchObject({
			target: { mode: 'production', database: 'fillando-prod', hosts: [origin.host] }
		})
		expect(await db.collection('catalog_control').countDocuments()).toBe(0)
	}, 60_000)

	it('dry-run refuses a plan the journal would refuse at apply (over 500 targets)', async () => {
		const attributes = [
			{ k: 'vyrobnyk', l: 'Виробник', v: 'Sunlu' },
			{ k: 'vaha', l: 'Вага', v: '1' },
			{ k: 'polymer', l: 'Тип пластику', v: 'PLA' }
		]
		// 300 single-SKU products: one plan of 600+ targets.
		await db.collection('products').insertMany(
			Array.from({ length: 300 }, (_, n) => ({
				_id: id(1000 + n),
				name: `Bulk ${n}`,
				category_id: id(1),
				attributes,
				variant_type: null
			}))
		)
		await db.collection('product_variants').insertMany(
			Array.from({ length: 300 }, (_, n) => ({
				_id: id(5000 + n),
				product_id: id(1000 + n),
				category_id: id(1),
				sku: `FL-B${n}`,
				slug: `bulk-${n}`,
				name: `Bulk ${n}`,
				status: 'active',
				price: 500,
				stock: 1,
				// Coloured: the plan must get as far as its size.
				color_id: id(90),
				color_family: 'black',
				v_value: 'Black'
			}))
		)
		const result = await migrate('dry-run')
		expect(result.code).toBe(1)
		expect(result.stderr).toContain('PLAN_TOO_LARGE')
		expect(await db.collection('catalog_control').countDocuments({ phase: 'writing' })).toBe(0)
		// The rest of the suite migrates the original fixture.
		await db.collection('products').deleteMany({ _id: { $gte: id(1000), $lt: id(1300) } })
		await db
			.collection('product_variants')
			.deleteMany({ _id: { $gte: id(5000), $lt: id(5300) } })
	}, 60_000)

	it('refuses apply when the backup no longer matches the live catalogue', async () => {
		const stale = await manifest('stale.json')
		// A writer still running after the backup: Prom changed one stock.
		await db.collection('product_variants').updateOne({ _id: id(20) }, { $set: { stock: 4 } })
		const result = await migrate(
			'apply',
			'--writers-stopped',
			`--confirm=apply:fillando-prod:${OPERATION}`,
			stale
		)
		expect(result.code).toBe(1)
		expect(result.stderr).toContain('BACKUP_DOES_NOT_MATCH_CATALOG: product_variants')
		expect(await db.collection('catalog_control').countDocuments()).toBe(0)
		expect(await db.collection('catalog_stage_runs').countDocuments()).toBe(0)
		// An old restore check is refused too, even with a matching catalogue.
		const old = await manifest('old.json', {
			checked_at: new Date(Date.now() - 25 * 36e5).toISOString()
		})
		const aged = await migrate(
			'apply',
			'--writers-stopped',
			`--confirm=apply:fillando-prod:${OPERATION}`,
			old
		)
		expect(aged.stderr).toContain('older than 24 h')
		// No confirmation, no connection.
		expect((await migrate('apply', '--writers-stopped', old)).stderr).toContain('confirmation')
	}, 60_000)

	it('applies with a matching backup and records it on the run', async () => {
		const backup = await manifest('backup.json')
		const result = await migrate(
			'apply',
			'--writers-stopped',
			`--confirm=apply:fillando-prod:${OPERATION}`,
			backup
		)
		expect(result.stderr).not.toMatch(/Error/)
		expect(JSON.parse(result.stdout)).toMatchObject({
			status: 'completed',
			legacy_fingerprint_unchanged: true
		})
		const runRecord = await db
			.collection('catalog_stage_runs')
			.findOne({ _id: OPERATION as never })
		expect(runRecord?.backup).toMatchObject({
			archive_name: 'fillando-prod-test.archive',
			archive_sha256: await target.sha256File(archive)
		})
		expect(await db.collection('categories').findOne({ _id: id(1) })).toMatchObject({
			attribute_contract_version: 2,
			status: 'active'
		})
		// The name addition is written into product and SKU names, before the variation.
		expect((await db.collection('products').findOne({ _id: id(10) }))?.name).toBe(
			'Sunlu PLA — Філамент'
		)
		expect((await db.collection('product_variants').findOne({ _id: id(20) }))?.name).toBe(
			'Sunlu PLA — Філамент — Чорний (Black)'
		)
	}, 60_000)

	it('switches the new admin writes idempotently, only while idle', async () => {
		const status = report((await writes('status')).stdout)
		expect(status.before).toMatchObject({
			control_present: true,
			phase: 'idle',
			admin_draft_writes_enabled: false,
			new_admin_can_write: false,
			legacy_admin_can_write: false,
			v2_categories: 1
		})
		expect((await writes('enable')).stderr).toContain('confirmation')
		const enabled = report((await writes('enable', '--confirm=enable:fillando-prod')).stdout)
		expect(enabled).toMatchObject({ result: 'changed', after: { new_admin_can_write: true } })
		const again = report((await writes('enable', '--confirm=enable:fillando-prod')).stdout)
		expect(again.result).toBe('unchanged')
		await writes('disable', '--confirm=disable:fillando-prod')
		await db
			.collection('catalog_control')
			.updateOne({ _id: 'catalog' as never }, { $set: { phase: 'writing' } })
		const busy = await writes('enable', '--confirm=enable:fillando-prod')
		expect(busy.stderr).toContain('CATALOG_NOT_IDLE')
		await db
			.collection('catalog_control')
			.updateOne({ _id: 'catalog' as never }, { $set: { phase: 'idle' } })
		expect(
			report((await writes('enable', '--confirm=enable:fillando-prod')).stdout).result
		).toBe('changed')
	}, 60_000)

	it('recovers only with the backup the run recorded', async () => {
		const otherArchive = path.join(dir, 'other.archive')
		writeFileSync(otherArchive, 'another backup!!!')
		const other = await manifest('other.json', {
			archive_path: otherArchive,
			archive_sha256: await target.sha256File(otherArchive)
		})
		const rollback = (backup: string) =>
			migrate(
				'rollback',
				'--writers-stopped',
				`--confirm=rollback:fillando-prod:${OPERATION}`,
				backup
			)
		expect((await rollback(other)).stderr).toContain(
			'not the backup recorded for the operation'
		)
		// The migration is finished: nothing to recover, nothing written.
		const finished = await rollback(`--backup-manifest=${path.join(dir, 'backup.json')}`)
		expect(JSON.parse(finished.stdout)).toMatchObject({
			operation: OPERATION,
			status: 'completed',
			already_finished: true
		})
		expect(await db.collection('categories').findOne({ _id: id(1) })).toMatchObject({
			attribute_contract_version: 2
		})
	}, 60_000)
})
