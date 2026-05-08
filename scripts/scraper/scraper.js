const { chromium } = require('playwright')
const axios = require('axios')
const fs = require('fs').promises
const path = require('path')

// ─── Config ──────────────────────────────────────────────────────────────────

const ARTICLES_FILE = 'scripts/scraper/articles.txt'
const OUTPUT_DIR = '/Users/vladyslav/Desktop/AssetsFilando/Filaments/PA6'
const REPORT_FILE = 'scripts/scraper/report.json'

const CONCURRENCY = 3
const DELAY_MIN = 2000
const DELAY_MAX = 3000
const PAGE_TIMEOUT = 30000
const DOWNLOAD_TIMEOUT = 20000

const BASE_URL = 'https://npshop.com.ua'
const SEARCH_BASE = `${BASE_URL}/ua/site_search`

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const LOCALE = 'uk-UA'
const VIEWPORT = { width: 1440, height: 900 }

// CSS selectors on the search results page — first link to a product
const SELECTOR_PRODUCT_LINK = 'a.b-product-gallery__image-link, a.b-goods-title'
// CSS selectors on the product page — gallery images
const SELECTOR_MAIN_IMAGE = 'img.b-product-image__img'
const SELECTOR_THUMBNAILS = 'img.b-images__img'

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

// ─── Browser scraping ────────────────────────────────────────────────────────

async function scrapeArticle(browser, article) {
	const context = await browser.newContext({
		userAgent: USER_AGENT,
		viewport: VIEWPORT,
		locale: LOCALE
	})

	const page = await context.newPage()

	try {
		// 1. Open search results
		const searchUrl = `${SEARCH_BASE}?search_term=${encodeURIComponent(article)}`
		await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT })

		// 2. Find first product link
		const firstLink = page.locator(SELECTOR_PRODUCT_LINK).first()
		const href = await firstLink.getAttribute('href').catch(() => null)

		if (!href) {
			return { article, status: 'no_results', imageUrls: [] }
		}

		// 3. Navigate to product page
		const productUrl = new URL(href, BASE_URL).href
		await page.goto(productUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT })

		// 4. Scroll to trigger any lazy-loading
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
		await sleep(1000)

		// 5. Collect image URLs (selectors passed as args because page.evaluate is sandboxed)
		const imageUrls = await page.evaluate(
			([mainSel, thumbSel]) => {
				const seen = new Set()

				// Main large image (already full-res, no size suffix)
				document.querySelectorAll(mainSel).forEach(img => {
					if (img.src) seen.add(img.src)
				})

				// Thumbnail strip — strip size suffix to get full-res
				document.querySelectorAll(thumbSel).forEach(img => {
					const src = img.src || img.dataset.src
					if (src) seen.add(src)
				})

				return [...seen]
			},
			[SELECTOR_MAIN_IMAGE, SELECTOR_THUMBNAILS]
		)

		// Strip size hints from thumbnails to get full-resolution URLs
		const resolved = [...new Set(imageUrls.map(fullSizeUrl))]

		if (!resolved.length) {
			return { article, status: 'no_images', imageUrls: [] }
		}

		return { article, status: 'found', imageUrls: resolved }
	} catch (err) {
		return { article, status: 'error', error: err.message, imageUrls: [] }
	} finally {
		await context.close()
	}
}

// ─── Image download ───────────────────────────────────────────────────────────

async function downloadImages(article, imageUrls) {
	const dirName = safeArticle(article)
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

// ─── Per-article orchestration ───────────────────────────────────────────────

async function processArticle(browser, article) {
	console.log(`\n→ ${article}`)

	const scraped = await scrapeArticle(browser, article)

	if (!scraped.imageUrls.length) {
		const note = scraped.error ? ` (${scraped.error})` : ''
		console.log(`  status: ${scraped.status}${note}`)
		return {
			article,
			status: scraped.status,
			images: [],
			...(scraped.error && { error: scraped.error })
		}
	}

	console.log(`  found ${scraped.imageUrls.length} image(s), downloading...`)
	const images = await downloadImages(article, scraped.imageUrls)
	console.log(`\n  ✓ ${images.length} saved`)

	await randomDelay()

	return { article, status: 'success', images }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	let raw
	try {
		raw = await fs.readFile(ARTICLES_FILE, 'utf-8')
	} catch {
		console.error(`${ARTICLES_FILE} not found. Create it with one article per line.`)
		process.exit(1)
	}

	const articles = raw
		.split('\n')
		.map(a => a.trim())
		.filter(Boolean)

	if (!articles.length) {
		console.error(`${ARTICLES_FILE} is empty.`)
		process.exit(1)
	}

	console.log(`Loaded ${articles.length} article(s). Concurrency: ${CONCURRENCY}\n`)

	const browser = await chromium.launch({ headless: true })
	const report = {}

	// Process in batches of CONCURRENCY
	for (let i = 0; i < articles.length; i += CONCURRENCY) {
		const batch = articles.slice(i, i + CONCURRENCY)
		const results = await Promise.all(batch.map(a => processArticle(browser, a)))

		for (const r of results) {
			report[r.article] = {
				status: r.status,
				images: r.images,
				...(r.error && { error: r.error })
			}
		}
	}

	await browser.close()

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
