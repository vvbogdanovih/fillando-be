/**
 * Batch price update for NicePrice (npshop.com.ua) vendor.
 *
 * Fetches all product variants that have a `prom_id` (populated by
 * BackfillPromIdNicePrice.js), opens the vendor product page directly by that
 * id — `https://npshop.com.ua/ua/p<prom_id>-x.html` (Prom redirects to the
 * canonical slug) — scrapes the current price, and updates the `price` field in
 * MongoDB using a fixed tiered markup (+30 ₴ for 0-200, +35 for 200-400,
 * +40 for 400-600, +45 for 600-800, +50 for 800-1000, +100 for 1000-1500,
 * +110 for 1500-2500, +120 for 2500+), rounded to a whole number — no kopecks.
 * No search-by-SKU step: matching is done purely by `prom_id`. Variants without
 * a `prom_id` are not touched (run BackfillPromIdNicePrice.js first).
 *
 * Usage:
 *   node scripts/AvailabilityCheck/prod/UpdatePriceNicePrice.js
 */

const axios = require('axios')
const mongoose = require('mongoose')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.prod') })

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}
const DELAY_MS = 1000 // delay between HTTP requests to the vendor site
const DRY_RUN = false // set to true to print results without writing to the database
const SKIP_IF_UPDATED_WITHIN_MS = 12 * 60 * 60 * 1000 // skip variant if price was updated less than 12 hours ago

const BASE_URL = 'https://npshop.com.ua'
const HTTP_TIMEOUT_MS = 20000
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Pricing ──────────────────────────────────────────────────────────────────

/** Fixed tiered markup (in ₴) based on vendor price range */
function getMarkupAmount(vendorPrice) {
	if (vendorPrice <= 200) return 30
	if (vendorPrice <= 400) return 35
	if (vendorPrice <= 600) return 40
	if (vendorPrice <= 800) return 45
	if (vendorPrice <= 1000) return 50
	if (vendorPrice <= 1500) return 100
	if (vendorPrice <= 2500) return 110
	return 120
}

// ── Scraping helpers ─────────────────────────────────────────────────────────

function normalizeSku(s) {
	return String(s || '')
		.replace(/\s+/g, ' ')
		.trim()
}

/** Product page URL built straight from a Prom id (slug is ignored on redirect). */
function productUrlFromPromId(promId) {
	return `${BASE_URL}/ua/p${encodeURIComponent(String(promId))}-x.html`
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

/**
 * Fetch price for a single variant by its Prom id.
 * `expectedSku` (optional) is used only as a sanity guard against a stale prom_id.
 * Returns { ok, vendorPrice, ...details }.
 */
async function fetchVendorPrice(promId, expectedSku) {
	const productUrl = productUrlFromPromId(promId)

	let productHtml
	try {
		productHtml = await fetchHtml(productUrl)
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.status === 404) {
			return { ok: false, error: 'not_found', productUrl, vendorPrice: null }
		}
		throw err
	}

	const dom = scrapeProductFromHtml(productHtml)

	if (expectedSku && dom.skuOnPage && normalizeSku(dom.skuOnPage) !== normalizeSku(expectedSku)) {
		return {
			ok: false,
			error: 'sku_mismatch',
			skuOnPage: dom.skuOnPage,
			productName: dom.productName,
			productUrl,
			vendorPrice: null
		}
	}

	if (dom.price === null) {
		return {
			ok: false,
			error: 'price_not_found',
			productName: dom.productName,
			productUrl,
			vendorPrice: null
		}
	}

	return {
		ok: true,
		vendorPrice: dom.price,
		productName: dom.productName,
		productUrl
	}
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms))
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

const ProductVariantSchema = new mongoose.Schema(
	{
		product_id: mongoose.Schema.Types.ObjectId,
		prom_id: String,
		vendor_product_sku: String,
		price: Number,
		price_updated_at: Date,
		status: String
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
		{ prom_id: { $exists: true, $nin: [null, ''] } },
		'_id prom_id vendor_product_sku price price_updated_at'
	).lean()
	console.log(`Found ${variants.length} variants with prom_id.\n`)

	if (variants.length === 0) {
		console.log('Nothing to update. Run BackfillPromIdNicePrice.js to populate prom_id first.')
		await mongoose.disconnect()
		return
	}

	const results = { updated: 0, skipped: 0, fresh: 0, errors: 0 }
	const now = Date.now()

	for (let i = 0; i < variants.length; i++) {
		const variant = variants[i]
		const promId = variant.prom_id
		const label = variant.vendor_product_sku || promId
		const prefix = `[${i + 1}/${variants.length}] ${label} (prom_id ${promId})`

		if (
			variant.price_updated_at &&
			now - new Date(variant.price_updated_at).getTime() < SKIP_IF_UPDATED_WITHIN_MS
		) {
			console.log(
				`${prefix} → FRESH (updated ${variant.price_updated_at.toISOString()}), skipping`
			)
			results.fresh++
			continue
		}

		let result
		try {
			result = await fetchVendorPrice(promId, variant.vendor_product_sku)
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
		const markup = getMarkupAmount(result.vendorPrice)
		const newPrice = Math.round(result.vendorPrice + markup)

		const changed = prevPrice !== newPrice
		const changeLabel = changed ? `${prevPrice} → ${newPrice}` : `${newPrice} (unchanged)`
		console.log(
			`${prefix} → vendor: ${result.vendorPrice} ₴ + ${markup} ₴ = ${newPrice} ₴ | ${changeLabel}${result.productName ? ` | "${result.productName}"` : ''}`
		)

		if (!DRY_RUN) {
			const $set = { price_updated_at: new Date() }
			if (changed) $set.price = newPrice
			await ProductVariant.updateOne({ _id: variant._id }, { $set })
		}

		if (changed) results.updated++
		else results.skipped++

		if (i < variants.length - 1) await sleep(DELAY_MS)
	}

	// Summary
	console.log('\n── Summary ─────────────────────────────────────')
	console.log(`  Total variants : ${variants.length}`)
	console.log(`  Updated        : ${results.updated}`)
	console.log(`  Fresh (skipped): ${results.fresh}`)
	console.log(`  Skipped        : ${results.skipped}`)
	console.log(`  Errors         : ${results.errors}`)
	if (DRY_RUN) console.log('  [dry-run] No changes were written.')

	await mongoose.disconnect()
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
