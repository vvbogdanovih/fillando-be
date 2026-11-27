#!/usr/bin/env node
// Pulls a fresh production dump into `dumps/` and restores it into the local development MongoDB.
//
//   yarn db:pull-prod                       dump production → dumps/, then replace the local database
//   yarn db:pull-prod --dump-only           only save a dump to dumps/ (emergency copy), local DB untouched
//   yarn db:pull-prod --from <archive.gz>   skip the dump, restore an existing archive into the local DB
//   options: --yes (no prompt), --source-db <name> (namespace inside the archive for --from)
//
// Production is only ever read (mongodump). Writes go to the local database only: the target is
// DATABASE_URL (process env, else `.env`, default mongodb://127.0.0.1:27019/fillando) and must be
// a loopback host — a remote target is refused before anything connects. The source is
// PROD_DATABASE_URL, else DATABASE_URL from `.env.prod`. URIs reach mongodump/mongorestore through
// a temporary 0600 config file, never through arguments, and are never printed — only their hosts.
//
// A non-empty local database is first dumped to dumps/local-<db>-<time>.archive.gz, then dropped
// and replaced, so no collection left from an older copy survives. Dumps contain customers' personal
// data: dumps/ is git- and docker-ignored, created 0700, archives 0600. Nothing is ever deleted
// from it — remove old archives by hand.
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const DUMPS_DIR = path.join(ROOT, 'dumps')
const DEFAULT_TARGET_URI = 'mongodb://127.0.0.1:27019/fillando'
const DEFAULT_SOURCE_DB = 'fillando-prod'
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const URI_PATTERN = /^(mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/
const RESTORE_SUMMARY =
	/(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore\./

const USAGE = `yarn db:pull-prod                       дамп проду → dumps/, потім заміна локальної бази
yarn db:pull-prod --dump-only           лише зберегти дамп у dumps/, локальна база не змінюється
yarn db:pull-prod --from <archive.gz>   без дампу: відновити наявний архів у локальну базу
  --yes             без підтвердження
  --source-db <db>  назва бази всередині архіву для --from (за замовчуванням ${DEFAULT_SOURCE_DB})`

class PlanError extends Error {}

function parseArgs(argv) {
	const args = { dumpOnly: false, yes: false, from: null, sourceDb: null, help: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--dump-only') args.dumpOnly = true
		else if (arg === '--yes' || arg === '-y') args.yes = true
		else if (arg === '--help' || arg === '-h') args.help = true
		else if (arg === '--from' || arg === '--source-db') {
			const value = argv[++i]
			if (!value || value.startsWith('--')) throw new PlanError(`${arg} потребує значення`)
			if (arg === '--from') args.from = value
			else args.sourceDb = value
		} else throw new PlanError(`Невідомий аргумент: ${arg}`)
	}
	if (args.dumpOnly && args.from) throw new PlanError('--dump-only і --from не поєднуються')
	return args
}

/** Hosts (lower-case, without credentials) and database of a MongoDB URI. */
function parseUri(uri) {
	const match = URI_PATTERN.exec(uri.trim())
	if (!match) throw new PlanError('URI має бути mongodb:// або mongodb+srv://')
	const hostPart = match[1].replace(/^mongodb(\+srv)?:\/\/(?:[^@/]*@)?/, '')
	return {
		srv: match[1].startsWith('mongodb+srv://'),
		hosts: hostPart.split(',').map(host => host.trim().toLowerCase()),
		database: match[2] ? decodeURIComponent(match[2]) : null
	}
}

const isLoopback = hosts => hosts.every(host => LOOPBACK_HOST.test(host))

/** The same URI without its database path (mongorestore renames via --nsFrom/--nsTo, not the path). */
function withoutDatabase(uri) {
	const match = URI_PATTERN.exec(uri.trim())
	if (!match) throw new PlanError('URI має бути mongodb:// або mongodb+srv://')
	return `${match[1]}/${match[3] ?? ''}`
}

/**
 * Decides what the run does. `env` is the process environment, `envText` / `envProdText` the texts
 * of `.env` / `.env.prod` (or null). Throws PlanError for anything that could write outside loopback.
 */
function resolvePlan({ args, env, envText, envProdText, parseDotenv }) {
	const plan = { mode: args.dumpOnly ? 'dump-only' : args.from ? 'restore' : 'pull' }

	if (plan.mode !== 'restore') {
		const sourceUri =
			env.PROD_DATABASE_URL ||
			(envProdText ? parseDotenv(envProdText).DATABASE_URL : undefined)
		if (!sourceUri)
			throw new PlanError(
				'Немає джерела: задайте PROD_DATABASE_URL або DATABASE_URL у .env.prod'
			)
		const source = parseUri(sourceUri)
		plan.source = {
			uri: sourceUri,
			hosts: source.hosts,
			database: source.database || DEFAULT_SOURCE_DB
		}
		if (args.sourceDb && args.sourceDb !== plan.source.database)
			throw new PlanError('--source-db лише для --from; база джерела береться з його URI')
	} else {
		plan.archive = path.resolve(args.from)
		plan.source = { database: args.sourceDb || DEFAULT_SOURCE_DB }
	}

	if (plan.mode !== 'dump-only') {
		const targetUri =
			env.DATABASE_URL ||
			(envText ? parseDotenv(envText).DATABASE_URL : undefined) ||
			DEFAULT_TARGET_URI
		const target = parseUri(targetUri)
		if (!isLoopback(target.hosts))
			throw new PlanError(
				`Ціль DATABASE_URL (${target.hosts.join(',')}) не локальна — відновлення дозволене лише в 127.0.0.1/localhost`
			)
		if (!target.database) throw new PlanError('У DATABASE_URL цілі немає назви бази')
		plan.target = { uri: targetUri, hosts: target.hosts, database: target.database }
		if (
			plan.source.hosts &&
			plan.source.database === target.database &&
			plan.source.hosts.join(',') === target.hosts.join(',')
		)
			throw new PlanError('Джерело й ціль — та сама база')
	}
	return plan
}

/** Counts from mongorestore's final line, or null when it printed none. */
function parseRestoreSummary(stderr) {
	const match = RESTORE_SUMMARY.exec(stderr)
	return match ? { restored: Number(match[1]), failed: Number(match[2]) } : null
}

function timestamp(date = new Date()) {
	const pad = n => String(n).padStart(2, '0')
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
		`${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	)
}

// ---------------------------------------------------------------------------------------------

/** Databases present in an archive, from the `archive prelude` lines of `mongorestore --dryRun -v`. */
function parseArchiveDatabases(stderr) {
	const names = [...stderr.matchAll(/archive prelude `([^`]+)`/g)].map(m => m[1].split('.')[0])
	return [...new Set(names)].sort()
}

/** Runs a MongoDB database tool with the URI in a 0600 config file; resolves { code, stderr }. */
async function runTool(tool, uri, args, { quiet = false } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fillando-db-'))
	const config = path.join(dir, 'config.yaml')
	fs.writeFileSync(config, `uri: '${uri.replaceAll("'", "''")}'\n`, { mode: 0o600 })
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(tool, [`--config=${config}`, ...args], {
				stdio: ['ignore', 'inherit', 'pipe']
			})
			let stderr = ''
			child.stderr.on('data', chunk => {
				stderr += chunk
				if (!quiet) process.stderr.write(chunk)
			})
			child.on('error', reject)
			child.on('close', code => resolve({ code, stderr }))
		})
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
}

function requireTools() {
	for (const tool of ['mongodump', 'mongorestore']) {
		const found = process.env.PATH.split(path.delimiter).some(dir => {
			try {
				fs.accessSync(path.join(dir, tool), fs.constants.X_OK)
				return true
			} catch {
				return false
			}
		})
		if (!found)
			throw new PlanError(
				`${tool} не знайдено. Встановити: brew install mongodb/brew/mongodb-database-tools`
			)
	}
}

async function collectionCounts(db) {
	const names = (await db.listCollections({}, { nameOnly: true }).toArray())
		.map(c => c.name)
		.filter(name => !name.startsWith('system.'))
		.sort()
	const counts = {}
	for (const name of names) counts[name] = await db.collection(name).estimatedDocumentCount()
	return counts
}

/** Fails before anything is dropped when the archive does not hold `database`. */
async function requireArchiveDatabase(archive, targetUri, database) {
	const { code, stderr } = await runTool(
		'mongorestore',
		withoutDatabase(targetUri),
		[`--archive=${archive}`, '--gzip', '--dryRun', '-v', '--nsInclude=__none__.*'],
		{ quiet: true }
	)
	const found = parseArchiveDatabases(stderr)
	if (code !== 0)
		throw new PlanError(`Архів не читається (mongorestore код ${code}): ${rel(archive)}`)
	if (!found.includes(database))
		throw new PlanError(
			`В архіві немає бази «${database}»; є: ${found.join(', ') || 'нічого'}. Вкажіть --source-db`
		)
}

async function connect(uri, timeoutMs, failure) {
	const { MongoClient } = require('mongodb')
	const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs })
	try {
		await client.connect()
		await client.db('admin').command({ ping: 1 })
		return client
	} catch (error) {
		await client.close().catch(() => {})
		throw new PlanError(`${failure}: ${error.message.split('\n')[0]}`)
	}
}

const total = counts => Object.values(counts).reduce((sum, n) => sum + n, 0)
const size = file => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`
const rel = file => {
	const relative = path.relative(process.cwd(), file)
	return relative && !relative.startsWith('..') ? relative : file
}

async function dumpTo(file, uri, database) {
	fs.mkdirSync(DUMPS_DIR, { recursive: true, mode: 0o700 })
	// Never overwrite a kept dump (two runs within the same second share a timestamp).
	const base = file.slice(0, -'.archive.gz'.length)
	for (let n = 2; fs.existsSync(file); n++) file = `${base}-${n}.archive.gz`
	const partial = `${file}.partial`
	const { code } = await runTool('mongodump', uri, [
		`--db=${database}`,
		`--archive=${partial}`,
		'--gzip'
	])
	if (code !== 0) {
		fs.rmSync(partial, { force: true })
		throw new Error(`mongodump завершився з кодом ${code}; неповний файл видалено`)
	}
	fs.renameSync(partial, file)
	fs.chmodSync(file, 0o600)
	console.log(`✓ Дамп: ${rel(file)} (${size(file)})`)
	return file
}

async function confirm(question) {
	if (!process.stdin.isTTY)
		throw new PlanError('Немає терміналу для підтвердження — додайте --yes')
	const readline = require('node:readline/promises')
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	try {
		return /^(y|yes|т|так)$/i.test((await rl.question(question)).trim())
	} finally {
		rl.close()
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.help) {
		console.log(USAGE)
		return
	}
	const read = file =>
		fs.existsSync(path.join(ROOT, file)) ? fs.readFileSync(path.join(ROOT, file), 'utf8') : null
	const plan = resolvePlan({
		args,
		env: process.env,
		envText: read('.env'),
		envProdText: read('.env.prod'),
		parseDotenv: require('dotenv').parse
	})
	requireTools()
	if (plan.archive && !fs.existsSync(plan.archive))
		throw new PlanError(`Архів не знайдено: ${plan.archive}`)

	let client
	let before = {}
	try {
		let sourceCounts
		if (plan.mode !== 'restore') {
			// Read-only preflight: mongodump itself waits forever on an unreachable server.
			const source = await connect(
				plan.source.uri,
				10000,
				`Джерело ${plan.source.hosts.join(',')} недоступне (мережа, IP whitelist Atlas, креди?)`
			)
			try {
				sourceCounts = await collectionCounts(source.db(plan.source.database))
			} finally {
				await source.close()
			}
			if (!Object.keys(sourceCounts).length)
				throw new PlanError(`База джерела «${plan.source.database}» порожня або не існує`)
		}
		if (plan.target) {
			client = await connect(
				plan.target.uri,
				3000,
				`Локальна MongoDB ${plan.target.hosts.join(',')} недоступна — запустіть yarn db:up`
			)
			before = await collectionCounts(client.db(plan.target.database))
		}
		if (plan.archive)
			await requireArchiveDatabase(plan.archive, plan.target.uri, plan.source.database)

		console.log('План:')
		if (plan.mode === 'restore')
			console.log(`  джерело: ${rel(plan.archive)} (база в архіві: ${plan.source.database})`)
		else
			console.log(
				`  джерело: ${plan.source.hosts.join(',')} / ${plan.source.database} — ` +
					`${Object.keys(sourceCounts).length} колекцій, ~${total(sourceCounts)} документів ` +
					'(лише читання) → dumps/'
			)
		if (plan.target) {
			const existing = Object.keys(before).length
			console.log(
				`  ціль:    ${plan.target.hosts.join(',')} / ${plan.target.database} ` +
					(existing
						? `— зараз ${existing} колекцій, ${total(before)} документів: буде збережено в dumps/ і ЗАМІНЕНО`
						: '— порожня')
			)
		}
		if (!args.yes && !(await confirm('Продовжити? [y/N] '))) {
			console.log('Скасовано.')
			return
		}

		const stamp = timestamp()
		let archive = plan.archive
		if (!archive) {
			archive = path.join(DUMPS_DIR, `${plan.source.database}-${stamp}.archive.gz`)
			archive = await dumpTo(archive, plan.source.uri, plan.source.database)
		}
		if (plan.mode === 'dump-only') return
		await requireArchiveDatabase(archive, plan.target.uri, plan.source.database)

		const db = client.db(plan.target.database)
		let backup = null
		if (Object.keys(before).length) {
			backup = path.join(DUMPS_DIR, `local-${plan.target.database}-${stamp}.archive.gz`)
			backup = await dumpTo(backup, plan.target.uri, plan.target.database)
			await db.dropDatabase()
			console.log(`✓ Локальну ${plan.target.database} очищено (копія: ${rel(backup)})`)
		}

		const { code, stderr } = await runTool('mongorestore', withoutDatabase(plan.target.uri), [
			`--archive=${archive}`,
			'--gzip',
			`--nsInclude=${plan.source.database}.*`,
			`--nsFrom=${plan.source.database}.*`,
			`--nsTo=${plan.target.database}.*`,
			'--stopOnError'
		])
		const summary = parseRestoreSummary(stderr)
		if (code !== 0 || !summary || summary.failed > 0 || summary.restored === 0)
			throw new Error(
				`mongorestore не вдався (код ${code}); локальна база може бути частково заповнена. ` +
					(backup
						? `Попередній стан: yarn db:pull-prod --from ${rel(backup)} --source-db ${plan.target.database}`
						: 'Повторіть команду — вона замінить базу заново')
			)

		const after = await collectionCounts(db)
		console.log(
			`✓ ${plan.target.database}: ${Object.keys(after).length} колекцій, ${total(after)} документів ` +
				`(mongorestore: ${summary.restored} відновлено, 0 помилок)`
		)
		if (plan.mode === 'pull') console.log('Перезапустіть бекенд, якщо він працював.')
	} finally {
		await client?.close()
	}
}

if (require.main === module) {
	main().catch(error => {
		console.error(`✗ ${error.message}`)
		process.exitCode = 1
	})
}

module.exports = {
	parseArgs,
	parseUri,
	isLoopback,
	withoutDatabase,
	resolvePlan,
	parseRestoreSummary,
	parseArchiveDatabases,
	timestamp,
	PlanError
}
