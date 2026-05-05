/**
 * Batch price update for NicePrice (npshop.com.ua) vendor.
 *
 * Fetches all product variants belonging to the NicePrice vendor that have
 * a `vendor_product_sku`, scrapes the current price on the vendor site,
 * and updates the `price` field in MongoDB to `vendor_price * 1.1` (rounded
 * to a whole number — no kopecks).
 *
 * Usage:
 *   node scripts/AvailabilityCheck/UpdatePriceNicePrice.js
 */

const axios = require('axios')
const mongoose = require('mongoose')

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL =
	'mongodb://fillando_dev_user:hE0noG8qaI6ezU4rkA3pcW7gdS9mwP@195.72.145.206:27017/fillando-dev?authSource=fillando-dev'
const DELAY_MS = 1500 // delay between HTTP requests to the vendor site
const DRY_RUN = false // set to true to print results without writing to the database
const MARKUP = 1.1 // price multiplier

const BASE_URL = 'https://npshop.com.ua'
const SEARCH_BASE = `${BASE_URL}/ua/site_search`
const HTTP_TIMEOUT_MS = 20000
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Scraping helpers ─────────────────────────────────────────────────────────

const RE_FIRST_GALLERY_HREF = /b-product-gallery__image-link["'][^>]*href="([^"]+)"/

function normalizeSku(s) {
	return String(s || '')
		.replace(/\s+/g, ' ')
		.trim()
}

function absoluteUrl(href) {
	if (!href) return null
	return href.startsWith('http') ? href : new URL(href, BASE_URL).href
}

function decodeAttrJson(raw) {
	return String(raw)
		.replace(/&quot;/g, '"')
		.replace(/&#34;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
}

async function fetchHtml(url) {
	const { data } = await axios.get(url, {
		timeout: HTTP_TIMEOUT_MS,
		headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'uk-UA,uk;q=0.9' },
		maxRedirects: 5,
		validateStatus: (s) => s >= 200 && s < 400,
	})
	return typeof data === 'string' ? data : String(data)
}

function firstProductUrlFromSearchHtml(html) {
	const m = html.match(RE_FIRST_GALLERY_HREF)
	return m ? absoluteUrl(m[1]) : null
}

function scrapeProductFromHtml(html) {
	// Price from data-qaid="product_price" (e.g. "425 ₴")
	let price = null
	const priceM = html.match(/data-qaid="product_price"[^>]*>([^<]*)/)
	if (priceM) {
		const digits = priceM[1].replace(/[^\d.,]/g, '').replace(',', '.')
		const parsed = parseFloat(digits)
		if (!isNaN(parsed) && parsed > 0) price = parsed
	}

	const skuM = html.match(/data-qaid="product_code"[^>]*>([^<]*)/)
	const skuOnPage = skuM ? normalizeSku(skuM[1]) : null

	const nameM = html.match(/data-qaid="product_name"[^>]*>([^<]*)/)
	const productName = nameM ? normalizeSku(nameM[1]) : null

	return { price, skuOnPage, productName }
}

/** Fetch price for a single SKU. Returns { ok, vendorPrice, ...details } */
async function fetchVendorPrice(sku) {
	const expectedSku = normalizeSku(sku)

	const searchHtml = await fetchHtml(
		`${SEARCH_BASE}?search_term=${encodeURIComponent(expectedSku)}`
	)
	const productUrl = firstProductUrlFromSearchHtml(searchHtml)

	if (!productUrl) {
		return { ok: false, error: 'no_search_results', vendorPrice: null }
	}

	const productHtml = await fetchHtml(productUrl)
	const dom = scrapeProductFromHtml(productHtml)

	if (dom.skuOnPage && normalizeSku(dom.skuOnPage) !== expectedSku) {
		return {
			ok: false,
			error: 'sku_mismatch',
			skuOnPage: dom.skuOnPage,
			productName: dom.productName,
			productUrl,
			vendorPrice: null,
		}
	}

	if (dom.price === null) {
		return {
			ok: false,
			error: 'price_not_found',
			productName: dom.productName,
			productUrl,
			vendorPrice: null,
		}
	}

	return {
		ok: true,
		vendorPrice: dom.price,
		productName: dom.productName,
		productUrl,
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

const ProductVariantSchema = new mongoose.Schema(
	{
		product_id: mongoose.Schema.Types.ObjectId,
		vendor_product_sku: String,
		price: Number,
		status: String,
	},
	{ collection: 'product_variants' }
)

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	if (DRY_RUN) console.log('[dry-run] No changes will be written to the database.\n')

	await mongoose.connect(DATABASE_URL)
	console.log('Connected to MongoDB.')

	const ProductVariant = mongoose.model('ProductVariant', ProductVariantSchema)

	const variants = await ProductVariant.find(
		{ vendor_product_sku: { $exists: true, $ne: '' } },
		'_id vendor_product_sku price'
	).lean()
	console.log(`Found ${variants.length} variants with vendor_product_sku.\n`)

	if (variants.length === 0) {
		console.log('Nothing to update.')
		await mongoose.disconnect()
		return
	}

	const results = { updated: 0, skipped: 0, errors: 0 }

	for (let i = 0; i < variants.length; i++) {
		const variant = variants[i]
		const sku = variant.vendor_product_sku
		const prefix = `[${i + 1}/${variants.length}] ${sku}`

		let result
		try {
			result = await fetchVendorPrice(sku)
		} catch (err) {
			console.error(`${prefix} → ERROR: ${err.message}`)
			results.errors++
			if (i < variants.length - 1) await sleep(DELAY_MS)
			continue
		}

		if (!result.ok) {
			console.warn(
				`${prefix} → SKIP (${result.error})${result.productName ? ` "${result.productName}"` : ''}`
			)
			results.skipped++
			if (i < variants.length - 1) await sleep(DELAY_MS)
			continue
		}

		const prevPrice = variant.price ?? 0
		const newPrice = Math.round(result.vendorPrice * MARKUP)

		const changed = prevPrice !== newPrice
		const changeLabel = changed ? `${prevPrice} → ${newPrice}` : `${newPrice} (unchanged)`
		console.log(
			`${prefix} → vendor: ${result.vendorPrice} ₴ × ${MARKUP} = ${newPrice} ₴ | ${changeLabel}${result.productName ? ` | "${result.productName}"` : ''}`
		)

		if (!DRY_RUN && changed) {
			await ProductVariant.updateOne({ _id: variant._id }, { $set: { price: newPrice } })
		}

		if (changed) results.updated++
		else results.skipped++

		if (i < variants.length - 1) await sleep(DELAY_MS)
	}

	// Summary
	console.log('\n── Summary ─────────────────────────────────────')
	console.log(`  Total variants : ${variants.length}`)
	console.log(`  Updated        : ${results.updated}`)
	console.log(`  Skipped        : ${results.skipped}`)
	console.log(`  Errors         : ${results.errors}`)
	if (DRY_RUN) console.log('  [dry-run] No changes were written.')

	await mongoose.disconnect()
}

main().catch((err) => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
