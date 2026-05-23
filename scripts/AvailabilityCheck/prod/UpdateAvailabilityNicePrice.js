/**
 * Batch availability update for NicePrice (npshop.com.ua) vendor.
 *
 * Fetches all product variants belonging to the NicePrice vendor that have
 * a `vendor_product_sku`, checks availability on the vendor site, and updates
 * the `stock` field in MongoDB.
 *
 * Usage:
 *   node scripts/AvailabilityCheck/prod/UpdateAvailabilityNicePrice.js
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
const SKIP_IF_UPDATED_WITHIN_MS = 12 * 60 * 60 * 1000 // skip variant if stock was updated less than 12 hours ago

const BASE_URL = 'https://npshop.com.ua'
const SEARCH_BASE = `${BASE_URL}/ua/site_search`
const HTTP_TIMEOUT_MS = 20000
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Scraping helpers (same as AvailabilityCheckNicePrice.js) ──────────────────

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
	let quantity = null
	const fbM = html.match(/data-advtracking-fb-product-data="([^"]*)"/)
	if (fbM) {
		try {
			const data = JSON.parse(decodeAttrJson(fbM[1]))
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

/** Check availability for a single SKU. Returns { ok, stock, ...details } */
async function checkAvailability(sku) {
	const expectedSku = normalizeSku(sku)
	let productUrl

	const searchHtml = await fetchHtml(
		`${SEARCH_BASE}?search_term=${encodeURIComponent(expectedSku)}`
	)
	productUrl = firstProductUrlFromSearchHtml(searchHtml)

	if (!productUrl) {
		return { ok: false, error: 'no_search_results', stock: 0 }
	}

	const productHtml = await fetchHtml(productUrl)
	const dom = scrapeProductFromHtml(productHtml)

	if (dom.skuOnPage && normalizeSku(dom.skuOnPage) !== expectedSku) {
		return {
			ok: false,
			error: 'sku_mismatch',
			skuOnPage: dom.skuOnPage,
			presenceText: dom.presenceText,
			productName: dom.productName,
			productUrl,
			stock: 0
		}
	}

	// Derive stock: use numeric quantity when available, fall back to presence text
	let stock = 0
	if (typeof dom.quantity === 'number') {
		stock = dom.quantity
	} else if (dom.presenceText) {
		// "є в наявності", "в наявності" → treat as 1
		// "Немає в наявності" → treat as 0
		stock = /наявн/i.test(dom.presenceText) && !/немає/i.test(dom.presenceText) ? 1 : 0
	}

	return {
		ok: true,
		stock,
		quantity: dom.quantity,
		presenceText: dom.presenceText,
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
		stock: Number,
		stock_updated_at: Date,
		status: String
	},
	{ collection: 'product_variants' }
)

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	if (DRY_RUN) console.log('[dry-run] No changes will be written to the database.\n')

	// Connect
	await mongoose.connect(DATABASE_URL)
	console.log('Connected to MongoDB.')

	const ProductVariant = mongoose.model('ProductVariant', ProductVariantSchema)

	// Find all variants that have a vendor_product_sku (NicePrice-sourced variants)
	const variants = await ProductVariant.find(
		{ vendor_product_sku: { $exists: true, $ne: '' } },
		'_id vendor_product_sku stock stock_updated_at'
	).lean()
	console.log(`Found ${variants.length} variants with vendor_product_sku.\n`)

	if (variants.length === 0) {
		console.log('Nothing to update.')
		await mongoose.disconnect()
		return
	}

	// 4. Check each variant and update
	const results = { updated: 0, skipped: 0, fresh: 0, errors: 0 }
	const now = Date.now()

	for (let i = 0; i < variants.length; i++) {
		const variant = variants[i]
		const sku = variant.vendor_product_sku
		const prefix = `[${i + 1}/${variants.length}] ${sku}`

		if (
			variant.stock_updated_at &&
			now - new Date(variant.stock_updated_at).getTime() < SKIP_IF_UPDATED_WITHIN_MS
		) {
			console.log(
				`${prefix} → FRESH (updated ${variant.stock_updated_at.toISOString()}), skipping`
			)
			results.fresh++
			continue
		}

		let result
		try {
			result = await checkAvailability(sku)
		} catch (err) {
			console.error(`${prefix} → ERROR: ${err.message}`)
			results.errors++
			if (i < variants.length - 1) await sleep(DELAY_MS)
			continue
		}

		if (!result.ok) {
			console.warn(
				`${prefix} → SKIP (${result.error})${result.presenceText ? ` presence="${result.presenceText}"` : ''}`
			)
			results.skipped++
			if (i < variants.length - 1) await sleep(DELAY_MS)
			continue
		}

		const prevStock = variant.stock ?? 0
		const newStock = result.stock

		const changed = prevStock !== newStock
		const changeLabel = changed ? `${prevStock} → ${newStock}` : `${newStock} (unchanged)`
		console.log(
			`${prefix} → stock: ${changeLabel}${result.presenceText ? ` | "${result.presenceText}"` : ''}`
		)

		if (!DRY_RUN) {
			const $set = { stock_updated_at: new Date() }
			if (changed) $set.stock = newStock
			await ProductVariant.updateOne({ _id: variant._id }, { $set })
		}

		if (changed) results.updated++
		else results.skipped++

		if (i < variants.length - 1) await sleep(DELAY_MS)
	}

	// 5. Summary
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
