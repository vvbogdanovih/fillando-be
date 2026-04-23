/**
 * NicePrice (npshop.com.ua / Prom company site) — залишок за артикулом.
 *
 * Лише HTTP (axios). Сторінки пошуку та картки товару віддають потрібне в HTML без JS.
 *
 * Джерела в HTML:
 * - перший `a.b-product-gallery__image-link` на сторінці пошуку → URL товару
 * - `data-advtracking-fb-product-data` → JSON `contents[0].quantity`
 * - `[data-qaid="product_code"]`, `presence_data`, `product_name`
 */

const axios = require('axios')

const BASE_URL = 'https://npshop.com.ua'
const SEARCH_BASE = `${BASE_URL}/ua/site_search`
const HTTP_TIMEOUT_MS = 20000

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Перший товар у видачі пошуку (як у scraper.js — галерея). */
const RE_FIRST_GALLERY_HREF = /b-product-gallery__image-link["'][^>]*href="([^"]+)"/

function normalizeSku(s) {
	return String(s || '')
		.replace(/\s+/g, ' ')
		.trim()
}

function parseArgs(argv) {
	const out = { article: null, productUrl: null }
	const rest = []
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--url' && argv[i + 1]) {
			out.productUrl = argv[++i]
			continue
		}
		if (a === '--help' || a === '-h') {
			out.help = true
			continue
		}
		rest.push(a)
	}
	if (rest.length) out.article = rest.join(' ').trim() || null
	return out
}

function printHelp() {
	console.error(`Usage:
  node scripts/AvailabilityCheckNicePrice.js <ARTICLE>
  node scripts/AvailabilityCheckNicePrice.js --url <PRODUCT_PAGE_URL>

Examples:
  node scripts/AvailabilityCheckNicePrice.js NPETG003-ZX
  node scripts/AvailabilityCheckNicePrice.js --url https://npshop.com.ua/ua/p2647349228-filament-plastik-dlya.html
`)
}

async function fetchHtml(url) {
	const { data } = await axios.get(url, {
		timeout: HTTP_TIMEOUT_MS,
		headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'uk-UA,uk;q=0.9' },
		maxRedirects: 5,
		validateStatus: s => s >= 200 && s < 400
	})
	return typeof data === 'string' ? data : String(data)
}

function absoluteUrl(href) {
	if (!href) return null
	return href.startsWith('http') ? href : new URL(href, BASE_URL).href
}

function firstProductUrlFromSearchHtml(html) {
	const m = html.match(RE_FIRST_GALLERY_HREF)
	return m ? absoluteUrl(m[1]) : null
}

function decodeAttrJsonJsonString(raw) {
	return String(raw)
		.replace(/&quot;/g, '"')
		.replace(/&#34;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
}

function scrapeProductFromHtml(html) {
	let quantity = null
	const fbM = html.match(/data-advtracking-fb-product-data="([^"]*)"/)
	if (fbM) {
		try {
			const data = JSON.parse(decodeAttrJsonJsonString(fbM[1]))
			const first = data?.contents?.[0]
			if (first && typeof first.quantity === 'number') quantity = first.quantity
		} catch {
			quantity = null
		}
	}

	const skuM = html.match(/data-qaid="product_code"[^>]*>([^<]*)/)
	const skuOnPage = skuM ? normalizeSku(skuM[1]) : null

	const presM = html.match(/data-qaid="presence_data"[^>]*>([^<]*)/)
	const presenceText = presM ? normalizeSku(presM[1]) : null

	const nameM = html.match(/data-qaid="product_name"[^>]*>([^<]*)/)
	const productName = nameM ? normalizeSku(nameM[1]) : null

	return { quantity, skuOnPage, presenceText, productName }
}

async function main() {
	const args = parseArgs(process.argv)
	if (args.help || (!args.article && !args.productUrl)) {
		printHelp()
		process.exit(args.help ? 0 : 1)
	}

	const expectedSku = args.article ? normalizeSku(args.article) : null
	let productUrl = args.productUrl
	let dom
	let finalUrl

	try {
		if (!productUrl) {
			const searchHtml = await fetchHtml(
				`${SEARCH_BASE}?search_term=${encodeURIComponent(expectedSku)}`
			)
			productUrl = firstProductUrlFromSearchHtml(searchHtml)
			if (!productUrl) {
				console.log(
					JSON.stringify(
						{
							ok: false,
							error: 'no_search_results',
							article: expectedSku,
							productUrl: null
						},
						null,
						2
					)
				)
				process.exit(2)
			}
		}

		const productHtml = await fetchHtml(productUrl)
		dom = scrapeProductFromHtml(productHtml)
		finalUrl = productUrl
	} catch (e) {
		console.error(
			JSON.stringify(
				{
					ok: false,
					error: 'http_failed',
					message: String(e?.message || e)
				},
				null,
				2
			)
		)
		process.exit(1)
	}

	if (expectedSku && dom.skuOnPage && normalizeSku(dom.skuOnPage) !== normalizeSku(expectedSku)) {
		console.log(
			JSON.stringify(
				{
					ok: false,
					error: 'sku_mismatch',
					article: expectedSku,
					skuOnPage: dom.skuOnPage,
					productUrl: finalUrl,
					quantity: dom.quantity,
					presenceText: dom.presenceText,
					productName: dom.productName
				},
				null,
				2
			)
		)
		process.exit(3)
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				article: expectedSku || dom.skuOnPage,
				skuOnPage: dom.skuOnPage,
				quantity: dom.quantity,
				presenceText: dom.presenceText,
				productName: dom.productName,
				productUrl: finalUrl,
				source: 'data-advtracking-fb-product-data → contents[0].quantity (HTTP)'
			},
			null,
			2
		)
	)
}

main().catch(err => {
	console.error(
		JSON.stringify({ ok: false, error: 'fatal', message: String(err?.message || err) }, null, 2)
	)
	process.exit(1)
})
