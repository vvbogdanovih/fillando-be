// node --test scripts/catalog-cli-target.test.cjs — no database, no network.
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const target = require('./catalog-cli-target.cjs')
const migrate = require('./catalog-v2-migrate.cjs')
const adminWrites = require('./catalog-admin-writes.cjs')
const recover = require('./catalog-recover.cjs')

const PROD_URI =
	'mongodb+srv://user:secret@cluster0.example.mongodb.net/fillando-prod?retryWrites=true'
const prodEnv = { DATABASE_URL: PROD_URI }
const localEnv = database => ({ DATABASE_URL: `mongodb://127.0.0.1:27019/${database}` })

test('the database is the backend DATABASE_URL: the environment first, then fillando-be/.env', () => {
	// The owner's local copy is named fillando-prod too, and is a valid local target (02.11.2026).
	assert.deepEqual(
		target.resolveTarget({
			database: 'fillando-prod',
			production: false,
			env: {},
			envFiles: ['PORT=9001\nDATABASE_URL=mongodb://127.0.0.1:27019/fillando-prod\n']
		}),
		{
			mode: 'local',
			uri: 'mongodb://127.0.0.1:27019/fillando-prod',
			database: 'fillando-prod',
			hosts: ['127.0.0.1:27019']
		}
	)
	const file = ['DATABASE_URL="mongodb://localhost:27019/fillando-prod"\n']
	assert.equal(
		target.resolveTarget({
			database: 'fillando-prod',
			production: false,
			env: {},
			envFiles: file
		}).database,
		'fillando-prod'
	)
	// The environment wins over the file, as for the app.
	const env = localEnv('fillando_catalog_local_v2')
	assert.equal(
		target.resolveTarget({
			database: 'fillando_catalog_local_v2',
			production: false,
			env,
			envFiles: file
		}).database,
		'fillando_catalog_local_v2'
	)
	// The name typed in the command must be the database the URI points to.
	assert.throws(
		() =>
			target.resolveTarget({
				database: 'fillando-prod',
				production: false,
				env,
				envFiles: file
			}),
		/points to the database fillando_catalog_local_v2, not fillando-prod/
	)
	// A URI without a database path takes the name from the command.
	assert.equal(
		target.resolveTarget({
			database: 'fillando_rehearsal_work_20261102',
			production: false,
			env: { DATABASE_URL: 'mongodb://127.0.0.1:27018' }
		}).database,
		'fillando_rehearsal_work_20261102'
	)
	assert.throws(
		() =>
			target.resolveTarget({
				database: 'fillando-prod',
				production: false,
				env: {},
				envFiles: []
			}),
		/not set/
	)
	assert.throws(
		() => target.resolveTarget({ database: undefined, production: false, env }),
		/Database name required/
	)
})

test('a remote server only with --production, which takes fillando-prod only', () => {
	assert.throws(
		() => target.resolveTarget({ database: 'fillando-prod', production: false, env: prodEnv }),
		/remote server \(cluster0\.example\.mongodb\.net\): writes there need --production/
	)
	const where = target.resolveTarget({
		database: 'fillando-prod',
		production: true,
		env: prodEnv
	})
	assert.equal(where.mode, 'production')
	assert.deepEqual(where.hosts, ['cluster0.example.mongodb.net'])
	assert.equal(JSON.stringify(target.describeTarget(where)).includes('secret'), false)
	// The production URI may sit in fillando-be/.env on release day (owner decision 02.11.2026).
	assert.equal(
		target.resolveTarget({
			database: 'fillando-prod',
			production: true,
			env: {},
			envFiles: [`DATABASE_URL=${PROD_URI}\n`]
		}).mode,
		'production'
	)
	assert.throws(
		() =>
			target.resolveTarget({
				database: 'fillando',
				production: true,
				env: { DATABASE_URL: 'mongodb+srv://u:p@c.example.net/fillando' }
			}),
		/only the database fillando-prod/
	)
	// The production path rehearsed on a loopback copy keeps every production protection.
	assert.equal(
		target.resolveTarget({
			database: 'fillando-prod',
			production: true,
			env: localEnv('fillando-prod')
		}).mode,
		'production'
	)
	assert.throws(() => target.hostsOf('postgres://x'), /mongodb/)
	assert.equal(target.databaseOf('mongodb+srv://u:p@h.net/fillando-prod?w=1'), 'fillando-prod')
	assert.equal(target.databaseOf('mongodb://127.0.0.1:27019'), null)
})

test('production writes need the full typed confirmation', () => {
	const where = target.resolveTarget({
		database: 'fillando-prod',
		production: true,
		env: prodEnv
	})
	assert.doesNotThrow(() =>
		target.requireConfirmation(
			where,
			['--confirm=apply:fillando-prod:op-1'],
			['apply', 'fillando-prod', 'op-1']
		)
	)
	for (const flags of [
		[],
		['--confirm=apply:fillando-prod'],
		['--confirm=rollback:fillando-prod:op-1']
	])
		assert.throws(
			() => target.requireConfirmation(where, flags, ['apply', 'fillando-prod', 'op-1']),
			/<command>:<database>:<operation-id>/
		)
	// Local mode needs no confirmation.
	target.requireConfirmation(
		target.resolveTarget({
			database: 'fillando_catalog_local_v2',
			production: false,
			env: localEnv('fillando_catalog_local_v2')
		}),
		[],
		['apply', 'fillando_catalog_local_v2', 'op-1']
	)
})

test('migration CLI validates the whole invocation before connecting', () => {
	const parse = (args, env = localEnv(args[1])) => migrate.parseInvocation(args, env, [])
	assert.equal(parse(['dry-run', 'fillando_catalog_local_v2', 'op']).target.mode, 'local')
	assert.equal(
		parse(['dry-run', 'fillando-prod', 'op', '--production'], prodEnv).target.mode,
		'production'
	)
	assert.throws(() => parse(['apply', 'fillando_catalog_local_v2', 'op']), /--writers-stopped/)
	// The owner's local fillando-prod migrates without --production; a remote one never does.
	assert.equal(parse(['apply', 'fillando-prod', 'op', '--writers-stopped']).target.mode, 'local')
	assert.throws(
		() => parse(['apply', 'fillando-prod', 'op', '--writers-stopped'], prodEnv),
		/--production/
	)
	assert.throws(
		() => parse(['apply', 'fillando-prod', 'op', '--production', '--writers-stopped'], prodEnv),
		/confirmation/
	)
	assert.throws(
		() =>
			parse(
				[
					'apply',
					'fillando-prod',
					'op',
					'--production',
					'--writers-stopped',
					'--confirm=apply:fillando-prod:op'
				],
				prodEnv
			),
		/--backup-manifest/
	)
	const ok = parse(
		[
			'rollback',
			'fillando-prod',
			'op',
			'--production',
			'--writers-stopped',
			'--confirm=rollback:fillando-prod:op',
			'--backup-manifest=b.json'
		],
		prodEnv
	)
	assert.equal(ok.backupManifest, path.resolve('b.json'))
	assert.throws(
		() =>
			parse([
				'apply',
				'fillando_catalog_local_v2',
				'op',
				'--writers-stopped',
				'--backup-manifest=b.json'
			]),
		/belong to --production/
	)
	assert.throws(
		() => parse(['dry-run', 'fillando_catalog_local_v2', 'op', '--force']),
		/Unknown option/
	)
	assert.throws(() => parse(['dry-run', 'fillando_catalog_local_v2', 'bad id']), /operation ID/)
	assert.deepEqual(
		parse(['backup-manifest', 'fillando_release_check_20261028', '--archive=a.archive']),
		{
			command: 'backup-manifest',
			name: 'fillando_release_check_20261028',
			archive: path.resolve('a.archive'),
			out: undefined
		}
	)
	for (const args of [
		['backup-manifest', 'fillando-prod', '--archive=a'],
		['backup-manifest', 'fillando_rehearsal_work_20261027', '--archive=a'],
		['backup-manifest', 'fillando_release_check_20261028']
	])
		assert.throws(() => parse(args))
	// backup-manifest reads the local restore check whatever DATABASE_URL says.
	assert.equal(
		parse(['backup-manifest', 'fillando_release_check_20261028', '--archive=a'], prodEnv)
			.command,
		'backup-manifest'
	)
})

test('admin-writes CLI: status is free, a production change needs confirmation', () => {
	const parse = (args, env = localEnv(args[1])) => adminWrites.parseInvocation(args, env, [])
	assert.equal(parse(['status', 'fillando_catalog_local_v2']).command, 'status')
	assert.equal(parse(['enable', 'fillando_rehearsal_work_20261027']).target.mode, 'local')
	assert.equal(
		parse(['status', 'fillando-prod', '--production'], prodEnv).target.mode,
		'production'
	)
	assert.throws(() => parse(['enable', 'fillando-prod', '--production'], prodEnv), /confirmation/)
	assert.equal(
		parse(
			['enable', 'fillando-prod', '--production', '--confirm=enable:fillando-prod'],
			prodEnv
		).command,
		'enable'
	)
	assert.throws(
		() =>
			parse(
				['disable', 'fillando-prod', '--production', '--confirm=enable:fillando-prod'],
				prodEnv
			),
		/confirmation/
	)
	assert.throws(() => parse(['enable', 'fillando-prod'], prodEnv), /--production/)
	assert.throws(
		() => parse(['enable', 'fillando_catalog_local_v2', '--confirm=enable:x']),
		/--production/
	)
	assert.throws(() => parse(['toggle', 'fillando_catalog_local_v2']), /Usage/)
})

test('recovery CLI: inspect is free, a write needs stopped writers and the typed confirmation', () => {
	const parse = (args, env = localEnv(args[1])) => recover.parseInvocation(args, env, [])
	// Without an operation ID, inspect reads the operation the gate is closed by.
	assert.equal(parse(['inspect', 'fillando_catalog_local_v2']).operation, undefined)
	assert.equal(
		parse(['inspect', 'fillando-prod', 'op-1', '--production'], prodEnv).operation,
		'op-1'
	)
	assert.throws(() => parse(['rollback', 'fillando_catalog_local_v2']), /operation ID/)
	assert.throws(() => parse(['resume', 'fillando_catalog_local_v2', 'op-1']), /writers-stopped/)
	assert.equal(
		parse(['resume', 'fillando_catalog_local_v2', 'op-1', '--writers-stopped']).command,
		'resume'
	)
	assert.throws(
		() =>
			parse(
				['rollback', 'fillando-prod', 'op-1', '--production', '--writers-stopped'],
				prodEnv
			),
		/confirmation/
	)
	assert.throws(
		() =>
			parse(
				[
					'rollback',
					'fillando-prod',
					'op-1',
					'--production',
					'--writers-stopped',
					'--confirm=resume:fillando-prod:op-1'
				],
				prodEnv
			),
		/confirmation/
	)
	assert.equal(
		parse(
			[
				'rollback',
				'fillando-prod',
				'op-1',
				'--production',
				'--writers-stopped',
				'--confirm=rollback:fillando-prod:op-1'
			],
			prodEnv
		).target.mode,
		'production'
	)
	assert.throws(
		() => parse(['rollback', 'fillando-prod', 'op-1', '--writers-stopped'], prodEnv),
		/--production/
	)
	assert.throws(() => parse(['inspect', 'fillando_catalog_local_v2', 'op 1']), /operation ID/)
	assert.throws(
		() => parse(['inspect', 'fillando_catalog_local_v2', '--force']),
		/Unknown option/
	)
	assert.throws(() => parse(['repair', 'fillando_catalog_local_v2']), /Usage/)
})

test('backup manifest: archive checksum, age, source and recorded backup', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'catalog-manifest-'))
	const archive = path.join(dir, 'fillando-prod-20261028.archive')
	writeFileSync(archive, 'archive bytes')
	const manifest = {
		kind: target.MANIFEST_KIND,
		version: 1,
		source_database: 'fillando-prod',
		archive_path: archive,
		archive_name: path.basename(archive),
		archive_bytes: 13,
		archive_sha256: await target.sha256File(archive),
		checked_at: '2026-10-28T10:00:00.000Z',
		catalog: {}
	}
	const write = (name, value) => {
		const file = path.join(dir, name)
		writeFileSync(file, JSON.stringify(value))
		return file
	}
	const good = write('good.json', manifest)
	const now = new Date('2026-10-28T20:00:00.000Z')
	assert.equal(
		(await target.verifyBackupManifest(good, { now, maxAgeHours: 24 })).archive_name,
		path.basename(archive)
	)
	await assert.rejects(
		target.verifyBackupManifest(good, {
			now: new Date('2026-10-29T11:00:00.000Z'),
			maxAgeHours: 24
		}),
		/older than 24 h/
	)
	// Recovery does not age out, but must name the backup the run recorded.
	await target.verifyBackupManifest(good, {
		now: new Date('2026-11-30'),
		sha256: manifest.archive_sha256
	})
	await assert.rejects(
		target.verifyBackupManifest(good, { sha256: 'f'.repeat(64) }),
		/recorded for the operation/
	)
	await assert.rejects(target.verifyBackupManifest(undefined), /--backup-manifest/)
	await assert.rejects(target.verifyBackupManifest(path.join(dir, 'missing.json')), /not found/)
	await assert.rejects(
		target.verifyBackupManifest(
			write('other-db.json', { ...manifest, source_database: 'fillando' })
		),
		/not a backup of fillando-prod/
	)
	await assert.rejects(
		target.verifyBackupManifest(write('kind.json', { ...manifest, kind: 'x' })),
		/Not a catalogue backup manifest/
	)
	await assert.rejects(
		target.verifyBackupManifest(
			write('sum.json', { ...manifest, archive_sha256: '0'.repeat(64) })
		),
		/checksum differs/
	)
	await assert.rejects(
		target.verifyBackupManifest(write('size.json', { ...manifest, archive_bytes: 1 })),
		/size differs/
	)
	await assert.rejects(
		target.verifyBackupManifest(
			write('gone.json', { ...manifest, archive_path: path.join(dir, 'gone') })
		),
		/missing/
	)
})

test('snapshot differences name every changed catalogue collection', () => {
	const snapshot = Object.fromEntries(
		target.CATALOG_COLLECTIONS.map(name => [name, { count: 1, hash: 'a' }])
	)
	assert.deepEqual(target.snapshotDifferences(snapshot, structuredClone(snapshot)), [])
	assert.deepEqual(
		target.snapshotDifferences(snapshot, {
			...snapshot,
			product_variants: { count: 1, hash: 'b' },
			landings: { count: 2, hash: 'a' }
		}),
		['product_variants', 'landings']
	)
	assert.deepEqual(target.snapshotDifferences(undefined, snapshot), target.CATALOG_COLLECTIONS)
})
