/**
 * Migration: generate width derivatives for every existing image in S3.
 *
 * For each original `…/<uuid>.<ext>` it writes `…/<uuid>-<width>.webp` for every
 * width in DERIVATIVE_WIDTHS. Sharp runs here, once, rather than per request in the
 * Next image optimizer — which is disabled precisely because it would OOM the VPS.
 *
 * ⚠️  RUN ORDER MATTERS. This must complete, and be spot-checked, BEFORE the
 *     frontend custom loader is enabled. Once the loader ships, every <img> points
 *     at a derivative key; a missing one is a hard 404 with no fallback.
 *
 * Set MODE below and re-run, in this order:
 *
 *     1. MODE = 'dry-run'   — see what would be written
 *     2. MODE = 'live'      — write the derivatives
 *     3. MODE = 'verify'    — confirm every tier exists (exits 1 if not)
 *     4. only then set NEXT_PUBLIC_USE_IMAGE_DERIVATIVES=true on the frontend
 *
 *   node scripts/migrations/generate-image-derivatives.js
 *
 * Idempotent: existing derivatives are skipped unless FORCE is on.
 *
 * One-off. New uploads get their derivatives automatically in `upload.service.ts`,
 * so once 'verify' passes cleanly this file can be deleted.
 *
 * Reads AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
 * AWS_S3_BUCKET_NAME from .env.
 */

const {
	S3Client,
	ListObjectsV2Command,
	HeadObjectCommand,
	GetObjectCommand,
	PutObjectCommand
} = require('@aws-sdk/client-s3')
const sharp = require('sharp')
require('dotenv').config()

// Keep in sync with DERIVATIVE_WIDTHS in src/modules/upload/upload.service.ts
// and TIERS in the frontend's image-loader.ts.
const DERIVATIVE_WIDTHS = [128, 320, 640, 1280]

/**
 * Edit between runs. One value instead of three booleans, so the modes cannot
 * contradict each other.
 *
 *   'dry-run' — write nothing, log what would be written
 *   'live'    — write the derivatives
 *   'verify'  — write nothing, HEAD every expected key, exit 1 on any gap
 */
const MODE = 'dry-run'

/** Rewrite derivatives that already exist. Only needed if WEBP_QUALITY or
 *  DERIVATIVE_WIDTHS changed; a normal re-run should leave this off. */
const FORCE = false

const CONCURRENCY = 5
/** Must match WEBP_QUALITY in src/modules/upload/upload.service.ts, otherwise
 *  backfilled images and newly uploaded ones come out at different quality. */
const WEBP_QUALITY = 80
const PREFIXES = ['products/', 'users/', 'vendors/', 'categories/']

if (!['dry-run', 'live', 'verify'].includes(MODE)) {
	console.error(`Invalid MODE "${MODE}". Expected 'dry-run', 'live' or 'verify'.`)
	process.exit(1)
}

const DRY_RUN = MODE === 'dry-run'
const VERIFY = MODE === 'verify'

const IMAGE_KEY_EXT = /\.(jpg|jpeg|png|webp)$/i
const DERIVATIVE_SUFFIX = new RegExp(`-(?:${DERIVATIVE_WIDTHS.join('|')})\\.webp$`)

const required = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET_NAME']
for (const key of required) {
	if (!process.env[key]) {
		console.error(`${key} is not set. Check your .env file.`)
		process.exit(1)
	}
}

const s3 = new S3Client({
	region: process.env.AWS_REGION,
	credentials: {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
	}
})
const BUCKET = process.env.AWS_S3_BUCKET_NAME

async function listOriginals() {
	const keys = []
	for (const prefix of PREFIXES) {
		let continuationToken
		do {
			const res = await s3.send(
				new ListObjectsV2Command({
					Bucket: BUCKET,
					Prefix: prefix,
					ContinuationToken: continuationToken
				})
			)
			for (const obj of res.Contents ?? []) {
				// Skip the derivatives themselves, and anything that is not an image.
				if (DERIVATIVE_SUFFIX.test(obj.Key)) continue
				if (!IMAGE_KEY_EXT.test(obj.Key)) continue
				keys.push(obj.Key)
			}
			continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
		} while (continuationToken)
	}
	return keys
}

async function exists(key) {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
		return true
	} catch {
		return false
	}
}

function derivativeKey(key, width) {
	return `${key.replace(IMAGE_KEY_EXT, '')}-${width}.webp`
}

async function verifyKey(key) {
	const missing = []
	for (const width of DERIVATIVE_WIDTHS) {
		if (!(await exists(derivativeKey(key, width)))) missing.push(width)
	}
	if (missing.length) {
		console.error(`  MISSING [${missing.join(', ')}] for ${key}`)
		return 'missing'
	}
	return 'ok'
}

async function processKey(key) {
	if (VERIFY) return verifyKey(key)

	if (!FORCE) {
		const present = await Promise.all(
			DERIVATIVE_WIDTHS.map(width => exists(derivativeKey(key, width)))
		)
		if (present.every(Boolean)) return 'skipped'
	}

	if (DRY_RUN) {
		console.log(`  [DRY RUN] Would write ${DERIVATIVE_WIDTHS.length} derivative(s): ${key}`)
		return 'would_write'
	}

	const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
	const original = Buffer.from(await obj.Body.transformToByteArray())

	let total = 0
	for (const width of DERIVATIVE_WIDTHS) {
		const buffer = await sharp(original)
			.resize({ width, withoutEnlargement: true })
			.webp({ quality: WEBP_QUALITY })
			.toBuffer()

		await s3.send(
			new PutObjectCommand({
				Bucket: BUCKET,
				Key: derivativeKey(key, width),
				Body: buffer,
				ContentType: 'image/webp',
				CacheControl: 'public, max-age=31536000, immutable'
			})
		)
		total += buffer.length
	}

	console.log(
		`  Wrote ${DERIVATIVE_WIDTHS.length} derivative(s): ${key} ` +
			`(original ${(original.length / 1024).toFixed(0)} KB → tiers ${(total / 1024).toFixed(0)} KB)`
	)
	return 'written'
}

async function runBatch(keys, fn, concurrency) {
	const results = []
	let idx = 0

	async function worker() {
		while (idx < keys.length) {
			const i = idx++
			try {
				results[i] = await fn(keys[i])
			} catch (err) {
				console.error(`  FAILED: ${keys[i]} — ${err.message}`)
				results[i] = 'failed'
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, keys.length) }, () => worker())
	await Promise.all(workers)
	return results
}

async function main() {
	console.log(`Mode: ${MODE}${FORCE ? ' (FORCE)' : ''}`)
	console.log(`Widths: ${DERIVATIVE_WIDTHS.join(', ')}, quality: ${WEBP_QUALITY}`)
	console.log(`Concurrency: ${CONCURRENCY}`)
	console.log(`Bucket: ${BUCKET}\n`)

	console.log('Listing S3 originals...')
	const keys = await listOriginals()
	console.log(`Found ${keys.length} original(s) across: ${PREFIXES.join(', ')}\n`)

	if (keys.length === 0) {
		console.log('Nothing to process.')
		return
	}

	console.log('Processing...')
	const results = await runBatch(keys, processKey, CONCURRENCY)

	const count = value => results.filter(r => r === value).length

	console.log('\n--- Summary ---')
	if (VERIFY) {
		const missing = count('missing')
		console.log(`Complete:   ${count('ok')}`)
		console.log(`Incomplete: ${missing}`)
		console.log(`Failed:     ${count('failed')}`)
		console.log(`Total:      ${keys.length}`)
		if (missing > 0 || count('failed') > 0) {
			console.error('\nDO NOT enable the frontend loader — derivatives are incomplete.')
			process.exit(1)
		}
		console.log('\nAll derivatives present. Safe to enable the frontend loader.')
	} else {
		if (DRY_RUN) console.log(`Would write: ${count('would_write')}`)
		else console.log(`Written:     ${count('written')}`)
		console.log(`Skipped:     ${count('skipped')}`)
		console.log(`Failed:      ${count('failed')}`)
		console.log(`Total:       ${keys.length}`)
		console.log(`\nNext: set MODE = '${DRY_RUN ? 'live' : 'verify'}' and re-run.`)
	}
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
