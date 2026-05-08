/**
 * Batch price update for NicePrice (npshop.com.ua) vendor.
 *
 * Fetches all product variants belonging to the NicePrice vendor that have
 * a `vendor_product_sku`, scrapes the current price on the vendor site,
 * and updates the `price` field in MongoDB using a tiered markup (25% for
 * 0-300 ₴, 13% for 300-500 ₴, 11% for 500-1500 ₴, 10% for 1500-5000 ₴,
 * 8% for 5000+ ₴), rounded to a whole number — no kopecks.
 *
 * Usage:
 *   node scripts/AvailabilityCheck/local/UpdatePriceNicePrice.js
 */

const axios = require('axios')
const mongoose = require('mongoose')
require('dotenv').config()

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}
const DELAY_MS = 1500 // delay between HTTP requests to the vendor site
const DRY_RUN = false // set to true to print results without writing to the database
const SKIP_IF_UPDATED_WITHIN_MS = 12 * 60 * 60 * 1000 // skip variant if price was updated less than 12 hours ago

const BASE_URL = 'https://npshop.com.ua'
const SEARCH_BASE = `${BASE_URL}/ua/site_search`
const HTTP_TIMEOUT_MS = 20000
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Pricing ──────────────────────────────────────────────────────────────────

/** Tiered markup based on vendor price range */
function getMarkup(vendorPrice) {
	if (vendorPrice <= 300) return 1.25
	if (vendorPrice <= 500) return 1.13
	if (vendorPrice <= 1500) return 1.11
	if (vendorPrice <= 5000) return 1.1
	return 1.08
}

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
		validateStatus: s => s >= 200 && s < 400
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
		{ vendor_product_sku: { $exists: true, $ne: '' } },
		'_id vendor_product_sku price price_updated_at'
	).lean()
	console.log(`Found ${variants.length} variants with vendor_product_sku.\n`)

	if (variants.length === 0) {
		console.log('Nothing to update.')
		await mongoose.disconnect()
		return
	}

	const results = { updated: 0, skipped: 0, fresh: 0, errors: 0 }
	const now = Date.now()

	for (let i = 0; i < variants.length; i++) {
		const variant = variants[i]
		const sku = variant.vendor_product_sku
		const prefix = `[${i + 1}/${variants.length}] ${sku}`

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
		const markup = getMarkup(result.vendorPrice)
		const newPrice = Math.round(result.vendorPrice * markup)

		const changed = prevPrice !== newPrice
		const changeLabel = changed ? `${prevPrice} → ${newPrice}` : `${newPrice} (unchanged)`
		console.log(
			`${prefix} → vendor: ${result.vendorPrice} ₴ × ${markup} = ${newPrice} ₴ | ${changeLabel}${result.productName ? ` | "${result.productName}"` : ''}`
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
