// node --test scripts/db-pull-prod.test.cjs — pure planning logic, no database or tools.
const test = require('node:test')
const assert = require('node:assert/strict')
const { parse } = require('dotenv')
const {
	parseArgs,
	parseUri,
	withoutDatabase,
	resolvePlan,
	parseRestoreSummary,
	parseArchiveDatabases,
	PlanError
} = require('./db-pull-prod.cjs')

// Fake fixture: `.invalid` is a reserved TLD, not a real Atlas host (keeps secret scanners quiet).
const PROD = 'mongodb+srv://user:p%40ss@cluster0.example.invalid/fillando-prod?appName=Cluster0'
const plan = (argv, { env = {}, envText = null, envProdText = `DATABASE_URL=${PROD}\n` } = {}) =>
	resolvePlan({ args: parseArgs(argv), env, envText, envProdText, parseDotenv: parse })

test('parseUri strips credentials and reads the database', () => {
	assert.deepEqual(parseUri(PROD), {
		srv: true,
		hosts: ['cluster0.example.invalid'],
		database: 'fillando-prod'
	})
	assert.deepEqual(parseUri('mongodb://a:1,B:2').hosts, ['a:1', 'b:2'])
	assert.equal(parseUri('mongodb://127.0.0.1:27019/').database, null)
	assert.throws(() => parseUri('postgres://x'), PlanError)
})

test('withoutDatabase keeps hosts and options', () => {
	assert.equal(
		withoutDatabase('mongodb://127.0.0.1:27019/fillando'),
		'mongodb://127.0.0.1:27019/'
	)
	assert.equal(
		withoutDatabase('mongodb://u:p@localhost:27019/db?authSource=admin'),
		'mongodb://u:p@localhost:27019/?authSource=admin'
	)
})

test('default pull: .env.prod source, default local target', () => {
	const p = plan([])
	assert.equal(p.mode, 'pull')
	assert.equal(p.source.database, 'fillando-prod')
	assert.equal(p.target.uri, 'mongodb://127.0.0.1:27019/fillando')
})

test('PROD_DATABASE_URL and DATABASE_URL from env win over files', () => {
	const p = plan([], {
		env: {
			PROD_DATABASE_URL: 'mongodb://h:1/src',
			DATABASE_URL: 'mongodb://localhost:27019/dev'
		},
		envText: 'DATABASE_URL=mongodb://127.0.0.1:27019/other\n'
	})
	assert.equal(p.source.database, 'src')
	assert.equal(p.target.database, 'dev')
})

test('a remote target is refused', () => {
	assert.throws(() => plan([], { envText: `DATABASE_URL=${PROD}\n` }), /не локальна/)
	assert.throws(
		() => plan([], { env: { DATABASE_URL: 'mongodb://127.0.0.1:1,db.example.com/x' } }),
		/не локальна/
	)
})

test('missing source, missing target database, same source and target are refused', () => {
	assert.throws(() => plan([], { envProdText: null }), /Немає джерела/)
	assert.throws(
		() => plan([], { env: { DATABASE_URL: 'mongodb://127.0.0.1:27019' } }),
		/немає назви бази/
	)
	assert.throws(
		() => plan([], { env: { PROD_DATABASE_URL: 'mongodb://127.0.0.1:27019/fillando' } }),
		/та сама база/
	)
})

test('dump-only needs no target; --from needs no source', () => {
	const dump = plan(['--dump-only'], { envText: `DATABASE_URL=${PROD}\n` })
	assert.equal(dump.target, undefined)
	const restore = plan(['--from', 'x.archive.gz', '--source-db', 'old'], { envProdText: null })
	assert.equal(restore.mode, 'restore')
	assert.equal(restore.source.database, 'old')
	assert.throws(() => parseArgs(['--dump-only', '--from', 'x']), PlanError)
	assert.throws(() => parseArgs(['--from']), PlanError)
	assert.throws(() => parseArgs(['--drop']), PlanError)
})

test('parseRestoreSummary reads mongorestore final line', () => {
	assert.deepEqual(
		parseRestoreSummary(
			'...\n2026-11-27T10:00:00.000+0200\t67002 document(s) restored successfully. 0 document(s) failed to restore.\n'
		),
		{ restored: 67002, failed: 0 }
	)
	assert.equal(parseRestoreSummary('error'), null)
})

test('parseArchiveDatabases lists databases from the dry-run prelude', () => {
	const stderr =
		'2026-11-27T10:54:33.346+0200\tarchive prelude `fillando-prod.orders`\n' +
		'2026-11-27T10:54:33.346+0200\tarchive prelude `fillando-prod.products`\n' +
		'2026-11-27T10:54:33.346+0200\tarchive prelude `other.x.y`\n'
	assert.deepEqual(parseArchiveDatabases(stderr), ['fillando-prod', 'other'])
	assert.deepEqual(parseArchiveDatabases(''), [])
})
