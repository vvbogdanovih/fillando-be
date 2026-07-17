/**
 * Photo scraper for NicePrice (npshop.com.ua / Prom) products.
 *
 * For each Prom product id in articles.txt (one id per line):
 *   1. Fetches the product from the Prom public API
 *      (`GET https://my.prom.ua/api/v1/products/<prom_id>`, Bearer PROM_API_KEY)
 *      and collects full-resolution image URLs from `images` / `main_image`.
 *   2. Downloads the images into OUTPUT_DIR/<sku>/ (falls back to the prom id
 *      when the product has no sku).
 *
 * Requires PROM_API_KEY in the repo root .env.
 *
 * Usage:
 *   node scripts/scraper/scraper.js
 */

const axios = require('axios')
const fs = require('fs').promises
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

// ─── Config ──────────────────────────────────────────────────────────────────

const ARTICLES_FILE = path.resolve(__dirname, 'articles.txt')
const OUTPUT_DIR = '/Users/vladyslav/Desktop/AssetsFilando/Filaments/Bambu Lab/ABS-GF'
const REPORT_FILE = path.resolve(__dirname, 'report.json')

const PROM_API_KEY = process.env.PROM_API_KEY
if (!PROM_API_KEY) {
	console.error('PROM_API_KEY is not set. Check your .env file.')
	process.exit(1)
}

const PROM_API_BASE = 'https://my.prom.ua/api/v1'
const MAX_RETRIES = 10
const RETRY_DELAY_MS = 3000

const DELAY_MIN = 1000
const DELAY_MAX = 2000
const HTTP_TIMEOUT_MS = 20000
const DOWNLOAD_TIMEOUT = 20000

const BASE_URL = 'https://npshop.com.ua' // used only as Referer for image downloads

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function randomDelay() {
	return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN))
}

/** Sanitize article for use as a directory / filename (e.g. "NPETG088-ZX/B" → "NPETG088-ZX-B") */
function safeArticle(article) {
	return article.replace(/[/\\:*?"<>|]/g, '-').trim()
}

/**
 * prom.ua stores thumbnails with size hints in the URL:
 *   https://images.prom.ua/6703014769_w100_h100_filename.jpg
 * Strip the size part to get the original full-resolution image:
 *   https://images.prom.ua/6703014769_filename.jpg
 */
function fullSizeUrl(url) {
	return url.replace(/_w\d+_h\d+_/, '_')
}

// ─── Prom API ─────────────────────────────────────────────────────────────────

/**
 * Fetch a product from the Prom public API by its Prom id.
 * Returns null when the product does not exist (404). Retries on 429 / 5xx /
 * network errors with a linear backoff (same as PromService in the backend).
 */
async function fetchPromProduct(promId) {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await axios.get(`${PROM_API_BASE}/products/${promId}`, {
				headers: { Authorization: `Bearer ${PROM_API_KEY}` },
				timeout: HTTP_TIMEOUT_MS
			})
			return data?.product ?? null
		} catch (err) {
			const status = axios.isAxiosError(err) ? err.response?.status : undefined

			if (status === 404) return null

			const retriable =
				status === 429 || status === undefined || (status !== undefined && status >= 500)

			if (retriable && attempt < MAX_RETRIES) {
				console.warn(
					`  [prom api] fetch ${promId} failed (status ${status ?? 'network'}), retry ${attempt}/${MAX_RETRIES}`
				)
				await sleep(RETRY_DELAY_MS * attempt)
				continue
			}

			throw err
		}
	}

	return null
}

/** Collect full-resolution image URLs from a Prom API product payload. */
function imageUrlsFromProduct(product) {
	const seen = new Set()

	if (product.main_image) seen.add(fullSizeUrl(product.main_image))

	for (const img of product.images || []) {
		const url = img?.url || img?.thumbnail_url
		if (url) seen.add(fullSizeUrl(url))
	}

	return [...seen]
}

// ─── Image download ───────────────────────────────────────────────────────────

async function downloadImages(name, imageUrls) {
	const dirName = safeArticle(name)
	const dir = path.join(OUTPUT_DIR, dirName)
	await fs.mkdir(dir, { recursive: true })

	const downloaded = []

	for (let i = 0; i < imageUrls.length; i++) {
		const url = imageUrls[i]
		const ext = path.extname(new URL(url).pathname).toLowerCase() || '.jpg'
		const filename = `${dirName}_${i + 1}${ext}`
		const filepath = path.join(dir, filename)

		try {
			const response = await axios.get(url, {
				responseType: 'arraybuffer',
				timeout: DOWNLOAD_TIMEOUT,
				headers: {
					Referer: `${BASE_URL}/`,
					'User-Agent': USER_AGENT
				}
			})

			await fs.writeFile(filepath, response.data)
			downloaded.push(filename)
			process.stdout.write('.')
		} catch (err) {
			console.error(`\n  [download error] ${url} — ${err.message}`)
		}
	}

	return downloaded
}

// ─── Per-product orchestration ───────────────────────────────────────────────

async function processProduct(promId) {
	console.log(`\n→ prom_id ${promId}`)

	let product
	try {
		product = await fetchPromProduct(promId)
	} catch (err) {
		console.log(`  status: error (${err.message})`)
		return { promId, status: 'error', images: [], error: err.message }
	}

	if (!product) {
		console.log('  status: not_found (prom api 404)')
		return { promId, status: 'not_found', images: [] }
	}

	// Directory is named after the product sku; fall back to the prom id
	const dirName = product.sku ? String(product.sku) : String(promId)
	console.log(`  sku: ${product.sku || '(none)'} | ${product.name || ''}`)

	const imageUrls = imageUrlsFromProduct(product)

	if (!imageUrls.length) {
		console.log('  status: no_images')
		return { promId, sku: product.sku, status: 'no_images', images: [] }
	}

	console.log(`  found ${imageUrls.length} image(s), downloading...`)
	const images = await downloadImages(dirName, imageUrls)
	console.log(`\n  ✓ ${images.length} saved`)

	return { promId, sku: product.sku, status: 'success', images }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	let raw
	try {
		raw = await fs.readFile(ARTICLES_FILE, 'utf-8')
	} catch {
		console.error(`${ARTICLES_FILE} not found. Create it with one Prom product id per line.`)
		process.exit(1)
	}

	const promIds = raw
		.split('\n')
		.map(a => a.trim())
		.filter(Boolean)

	if (!promIds.length) {
		console.error(`${ARTICLES_FILE} is empty.`)
		process.exit(1)
	}

	console.log(`Loaded ${promIds.length} Prom product id(s).`)

	const report = {}

	for (let i = 0; i < promIds.length; i++) {
		const r = await processProduct(promIds[i])

		report[r.promId] = {
			status: r.status,
			...(r.sku && { sku: r.sku }),
			images: r.images,
			...(r.error && { error: r.error })
		}

		if (i < promIds.length - 1) await randomDelay()
	}

	await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8')
	console.log(`\n\nDone. Report saved to ${REPORT_FILE}`)

	const total = Object.keys(report).length
	const ok = Object.values(report).filter(r => r.status === 'success').length
	console.log(`Summary: ${ok}/${total} success, ${total - ok} failed`)
}

main().catch(err => {
	console.error('Fatal:', err)
	process.exit(1)
})
