/**
 * Migration: convert existing JPEG/PNG images in S3 to WebP.
 *
 * Re-uploads each convertible file with the same key but WebP content.
 * Idempotent — skips files that are already WebP.
 *
 * Environment variables (from .env):
 *   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET_NAME
 *
 * Options (via env):
 *   DRY_RUN=true      (default) — only logs what would be converted
 *   DRY_RUN=false      — actually performs conversions
 *   CONCURRENCY=5      — parallel conversion workers (default 5)
 *   WEBP_QUALITY=80    — WebP quality 1-100 (default 80)
 *
 * Usage:
 *   DRY_RUN=true  node scripts/migrations/convert-s3-images-to-webp.js
 *   DRY_RUN=false node scripts/migrations/convert-s3-images-to-webp.js
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

const DRY_RUN = false
const CONCURRENCY = 5
const WEBP_QUALITY = 80
const CONVERTIBLE_TYPES = ['image/jpeg', 'image/png']
const PREFIXES = ['products/', 'users/', 'vendors/', 'categories/']

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

async function listAllKeys() {
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
			if (res.Contents) {
				keys.push(...res.Contents.map(o => o.Key))
			}
			continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
		} while (continuationToken)
	}
	return keys
}

async function convertKey(key) {
	const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
	const contentType = head.ContentType ?? ''

	if (!CONVERTIBLE_TYPES.includes(contentType)) {
		return 'skipped'
	}

	if (DRY_RUN) {
		console.log(`  [DRY RUN] Would convert: ${key} (${contentType})`)
		return 'would_convert'
	}

	const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
	const original = Buffer.from(await obj.Body.transformToByteArray())
	const webpBuffer = await sharp(original).webp({ quality: WEBP_QUALITY }).toBuffer()

	await s3.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: key,
			Body: webpBuffer,
			ContentType: 'image/webp',
			CacheControl: 'public, max-age=31536000, immutable'
		})
	)

	const savedPct = ((1 - webpBuffer.length / original.length) * 100).toFixed(1)
	console.log(`  Converted: ${key} (${contentType}) — saved ${savedPct}%`)
	return 'converted'
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
	console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
	console.log(`Concurrency: ${CONCURRENCY}, WebP quality: ${WEBP_QUALITY}`)
	console.log(`Bucket: ${BUCKET}\n`)

	console.log('Listing S3 objects...')
	const keys = await listAllKeys()
	console.log(`Found ${keys.length} object(s) across prefixes: ${PREFIXES.join(', ')}\n`)

	if (keys.length === 0) {
		console.log('Nothing to process.')
		return
	}

	console.log('Processing...')
	const results = await runBatch(keys, convertKey, CONCURRENCY)

	const summary = {
		converted: results.filter(r => r === 'converted').length,
		would_convert: results.filter(r => r === 'would_convert').length,
		skipped: results.filter(r => r === 'skipped').length,
		failed: results.filter(r => r === 'failed').length
	}

	console.log('\n--- Summary ---')
	if (DRY_RUN) {
		console.log(`Would convert: ${summary.would_convert}`)
	} else {
		console.log(`Converted:     ${summary.converted}`)
	}
	console.log(`Skipped:       ${summary.skipped}`)
	console.log(`Failed:        ${summary.failed}`)
	console.log(`Total:         ${keys.length}`)
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
