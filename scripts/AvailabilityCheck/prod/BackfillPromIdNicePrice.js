/**
 * One-time backfill of NicePrice (npshop.com.ua / Prom) product ids.
 *
 * For every product variant that has a `vendor_product_sku` but no `prom_id`,
 * this script searches the vendor site by SKU, resolves the product page, and
 * extracts the Prom product id from the URL (`/ua/p<id>-slug.html` → `<id>`),
 * then stores it in the `prom_id` field in MongoDB.
 *
 * Once populated, availability/price checks can hit the product page directly
 * via `https://npshop.com.ua/ua/p<prom_id>-x.html` without the search step.
 *
 * Usage:
 *   node scripts/AvailabilityCheck/prod/BackfillPromIdNicePrice.js
 */

const axios = require('axios')
const mongoose = require('mongoose')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') })

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}
const DELAY_MS = 1000 // delay between HTTP requests to the vendor site
const DRY_RUN = false // set to true to print results without writing to the database
const FORCE = false // set to true to re-resolve prom_id even for variants that already have one

const BASE_URL = 'https://npshop.com.ua'
const SEARCH_BASE = `${BASE_URL}/ua/site_search`
const HTTP_TIMEOUT_MS = 20000
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ── Scraping helpers (same as AvailabilityCheckNicePrice.js) ──────────────────

const RE_FIRST_GALLERY_HREF = /b-product-gallery__image-link["'][^>]*href="([^"]+)"/
const RE_PROM_ID = /\/p(\d+)[-.]/

function normalizeSku(s) {
	return String(s || '')
		.replace(/\s+/g, ' ')
		.trim()
}

function absoluteUrl(href) {
	if (!href) return null
	return href.startsWith('http') ? href : new URL(href, BASE_URL).href
}

async function fetchHtml(url) {
	const res = await axios.get(url, {
		timeout: HTTP_TIMEOUT_MS,
		headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'uk-UA,uk;q=0.9' },
		maxRedirects: 5,
		validateStatus: s => s >= 200 && s < 400
	})
	const finalUrl = res.request?.res?.responseUrl || url
	const data = typeof res.data === 'string' ? res.data : String(res.data)
	return { html: data, finalUrl }
}

function firstProductUrlFromSearchHtml(html) {
	const m = html.match(RE_FIRST_GALLERY_HREF)
	return m ? absoluteUrl(m[1]) : null
}

function promIdFromUrl(url) {
	const m = String(url || '').match(RE_PROM_ID)
	return m ? m[1] : null
}

function skuFromHtml(html) {
	const skuM = html.match(/data-qaid="product_code"[^>]*>([^<]*)/)
	return skuM ? normalizeSku(skuM[1]) : null
}

/** Resolve prom_id for a single SKU. Returns { ok, promId, ...details } */
async function resolvePromId(sku) {
	const expectedSku = normalizeSku(sku)

	const search = await fetchHtml(`${SEARCH_BASE}?search_term=${encodeURIComponent(expectedSku)}`)
	const productUrl = firstProductUrlFromSearchHtml(search.html)

	if (!productUrl) {
		return { ok: false, error: 'no_search_results' }
	}

	const product = await fetchHtml(productUrl)
	const skuOnPage = skuFromHtml(product.html)

	if (skuOnPage && normalizeSku(skuOnPage) !== expectedSku) {
		return { ok: false, error: 'sku_mismatch', skuOnPage, productUrl: product.finalUrl }
	}

	// Prom id lives in the canonical (post-redirect) URL: /ua/p<id>-slug.html
	const promId = promIdFromUrl(product.finalUrl) || promIdFromUrl(productUrl)
	if (!promId) {
		return { ok: false, error: 'no_prom_id', productUrl: product.finalUrl }
	}

	return { ok: true, promId, productUrl: product.finalUrl }
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms))
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

const ProductVariantSchema = new mongoose.Schema(
	{
		vendor_product_sku: String,
		prom_id: String
	},
	{ collection: 'product_variants' }
)

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	if (DRY_RUN) console.log('[dry-run] No changes will be written to the database.\n')

	await mongoose.connect(DATABASE_URL)
	console.log('Connected to MongoDB.')

	const ProductVariant = mongoose.model('ProductVariant', ProductVariantSchema)

	const filter = { vendor_product_sku: { $exists: true, $ne: '' } }
	if (!FORCE) {
		filter.$or = [{ prom_id: { $exists: false } }, { prom_id: null }, { prom_id: '' }]
	}

	const variants = await ProductVariant.find(filter, '_id vendor_product_sku prom_id').lean()
	console.log(
		`Found ${variants.length} variants to resolve${FORCE ? ' (FORCE: re-resolving all)' : ' (missing prom_id)'}.\n`
	)

	if (variants.length === 0) {
		console.log('Nothing to backfill.')
		await mongoose.disconnect()
		return
	}

	const results = { updated: 0, unchanged: 0, skipped: 0, errors: 0 }

	for (let i = 0; i < variants.length; i++) {
		const variant = variants[i]
		const sku = variant.vendor_product_sku
		const prefix = `[${i + 1}/${variants.length}] ${sku}`

		let result
		try {
			result = await resolvePromId(sku)
		} catch (err) {
			console.error(`${prefix} → ERROR: ${err.message}`)
			results.errors++
			if (i < variants.length - 1) await sleep(DELAY_MS)
			continue
		}

		if (!result.ok) {
			console.warn(`${prefix} → SKIP (${result.error})`)
			results.skipped++
			if (i < variants.length - 1) await sleep(DELAY_MS)
			continue
		}

		const prev = variant.prom_id || null
		const changed = prev !== result.promId
		const label = changed
			? `${prev ? `${prev} → ` : ''}${result.promId}`
			: `${result.promId} (unchanged)`
		console.log(`${prefix} → prom_id: ${label}`)

		if (changed) {
			if (!DRY_RUN) {
				await ProductVariant.updateOne({ _id: variant._id }, { $set: { prom_id: result.promId } })
			}
			results.updated++
		} else {
			results.unchanged++
		}

		if (i < variants.length - 1) await sleep(DELAY_MS)
	}

	console.log('\n── Summary ─────────────────────────────────────')
	console.log(`  Total variants : ${variants.length}`)
	console.log(`  Updated        : ${results.updated}`)
	console.log(`  Unchanged      : ${results.unchanged}`)
	console.log(`  Skipped        : ${results.skipped}`)
	console.log(`  Errors         : ${results.errors}`)
	if (DRY_RUN) console.log('  [dry-run] No changes were written.')

	await mongoose.disconnect()
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
