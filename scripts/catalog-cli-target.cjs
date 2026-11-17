// Target guard shared by the catalogue release CLIs (catalog-v2-migrate.cjs, catalog-admin-writes.cjs,
// catalog-recover.cjs). The database is the backend's own: DATABASE_URL from the process environment,
// else from the checkout's `.env` — the same lookup as the app (owner decision 02.11.2026: locally it
// is the local copy, on release day the production URI is put there). What the URI points to decides
// the protection (Plan-0010 D08 §2): a loopback server is a local run; a remote one is refused unless
// `--production`, which in turn needs the database named `fillando-prod`, a typed confirmation of
// every write and, for the migration, a manifest of a restore-checked backup. The URI itself is never
// printed — only its hosts.
const { createHash } = require('node:crypto')
const { createReadStream, existsSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')
const dotenv = require('dotenv')

/** Read-only restore check of a production backup on the local MongoDB (backup-manifest). */
const RESTORE_CHECK_DATABASES = /^fillando_release_check_\d{8}$/
const PRODUCTION_DATABASE = 'fillando-prod'
const URI_VARIABLE = 'DATABASE_URL'
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
/** Catalogue collections a backup must reproduce before the migration may write. */
const CATALOG_COLLECTIONS = [
	'categories',
	'products',
	'product_variants',
	'landings',
	'colors',
	'brands'
]
const MANIFEST_KIND = 'fillando-catalog-backup-check'
const MANIFEST_MAX_AGE_HOURS = 24

class TargetError extends Error {
	constructor(message) {
		super(message)
		this.name = 'TargetError'
	}
}

const URI_PATTERN = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)(?:\/([^?#]*))?/

/** `host[:port]` list of a MongoDB URI without credentials, path or options. */
function hostsOf(uri) {
	const match = URI_PATTERN.exec(uri)
	if (!match) throw new TargetError(`${URI_VARIABLE} must be a mongodb:// or mongodb+srv:// URI`)
	return match[2].split(',').map(host => host.trim().toLowerCase())
}

/** The database named in the URI path, or null when the URI names none. */
function databaseOf(uri) {
	const name = URI_PATTERN.exec(uri)?.[3]
	return name ? decodeURIComponent(name) : null
}

/**
 * Resolves where a CLI connects. `envFiles` are the texts of the backend's dotenv files
 * ({@link readEnvFiles}); the process environment wins over them, as for the app.
 */
function resolveTarget({ database, production, env = process.env, envFiles = [] }) {
	const uri =
		env[URI_VARIABLE] || envFiles.map(text => dotenv.parse(text)[URI_VARIABLE]).find(Boolean)
	if (!uri)
		throw new TargetError(
			`${URI_VARIABLE} is not set — neither in the environment nor in the backend .env`
		)
	const hosts = hostsOf(uri)
	if (!database) throw new TargetError('Database name required (the one DATABASE_URL points to)')
	const named = databaseOf(uri)
	if (named && named !== database)
		throw new TargetError(
			`${URI_VARIABLE} points to the database ${named}, not ${database} — check fillando-be/.env`
		)
	const local = hosts.every(host => LOOPBACK_HOST.test(host))
	if (!local && !production)
		throw new TargetError(
			`${URI_VARIABLE} points to a remote server (${hosts.join(', ')}): writes there need --production`
		)
	if (production && database !== PRODUCTION_DATABASE)
		throw new TargetError(`--production targets only the database ${PRODUCTION_DATABASE}`)
	return { mode: production ? 'production' : 'local', uri, database, hosts }
}

/** The backend's dotenv file, as the app reads it (`dotenv/config` loads `.env`). */
function readEnvFiles(root) {
	const file = path.join(root, '.env')
	return existsSync(file) ? [readFileSync(file, 'utf8')] : []
}

/** Production writes need `--confirm=<command>:<database>[:<operation>]`, typed in full. */
function requireConfirmation(target, flags, parts) {
	if (target.mode !== 'production') return
	const expected = `--confirm=${parts.join(':')}`
	const given = flags.find(flag => flag.startsWith('--confirm='))
	if (given !== expected)
		throw new TargetError(
			`Production write needs an explicit confirmation flag of the form --confirm=${parts
				.map((_, index) => ['<command>', '<database>', '<operation-id>'][index])
				.join(':')}`
		)
}

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const digest = createHash('sha256')
		createReadStream(file)
			.on('error', reject)
			.on('data', chunk => digest.update(chunk))
			.on('end', () => resolve(digest.digest('hex')))
	})
}

/** Count and hash of every document (sorted by _id) of the catalogue collections. */
async function catalogSnapshot(db, BSON) {
	const result = {}
	for (const name of CATALOG_COLLECTIONS) {
		const digest = createHash('sha256')
		let count = 0
		for await (const row of db.collection(name).find({}).sort({ _id: 1 })) {
			digest.update(BSON.serialize(row))
			count++
		}
		result[name] = { count, hash: digest.digest('hex') }
	}
	return result
}

/** Collections whose snapshot differs; empty when the backup reproduces the live catalogue. */
function snapshotDifferences(expected, actual) {
	return CATALOG_COLLECTIONS.filter(
		name =>
			expected?.[name]?.count !== actual?.[name]?.count ||
			expected?.[name]?.hash !== actual?.[name]?.hash
	)
}

/**
 * Reads a backup manifest and re-checks the archive it names: the file exists, its SHA-256 is
 * the recorded one, and (for a fresh migration) the restore check is recent. The catalogue
 * snapshot is compared by the caller against the live database.
 */
async function verifyBackupManifest(file, { now = new Date(), maxAgeHours, sha256 } = {}) {
	if (!file) throw new TargetError('Production migration needs --backup-manifest=<path>')
	if (!existsSync(file)) throw new TargetError('Backup manifest not found')
	let manifest
	try {
		manifest = JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		throw new TargetError('Backup manifest is not valid JSON')
	}
	if (manifest?.kind !== MANIFEST_KIND || manifest.version !== 1)
		throw new TargetError('Not a catalogue backup manifest (backup-manifest command)')
	if (manifest.source_database !== PRODUCTION_DATABASE)
		throw new TargetError('Backup manifest is not a backup of fillando-prod')
	if (!manifest.archive_path || !existsSync(manifest.archive_path))
		throw new TargetError('Backup archive named by the manifest is missing')
	if (statSync(manifest.archive_path).size !== manifest.archive_bytes)
		throw new TargetError('Backup archive size differs from the manifest')
	if ((await sha256File(manifest.archive_path)) !== manifest.archive_sha256)
		throw new TargetError('Backup archive checksum differs from the manifest')
	if (sha256 && manifest.archive_sha256 !== sha256)
		throw new TargetError('This is not the backup recorded for the operation')
	if (maxAgeHours !== undefined) {
		const age = (now.getTime() - Date.parse(manifest.checked_at)) / 36e5
		if (!(age >= 0 && age <= maxAgeHours))
			throw new TargetError(
				`Backup restore check is older than ${maxAgeHours} h (or in the future)`
			)
	}
	return manifest
}

/** Credentials-free description of the target for logs. */
function describeTarget(target) {
	return { mode: target.mode, database: target.database, hosts: target.hosts }
}

module.exports = {
	CATALOG_COLLECTIONS,
	MANIFEST_KIND,
	MANIFEST_MAX_AGE_HOURS,
	PRODUCTION_DATABASE,
	RESTORE_CHECK_DATABASES,
	TargetError,
	URI_VARIABLE,
	catalogSnapshot,
	databaseOf,
	describeTarget,
	hostsOf,
	readEnvFiles,
	requireConfirmation,
	resolveTarget,
	sha256File,
	snapshotDifferences,
	verifyBackupManifest
}
