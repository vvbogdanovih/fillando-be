/**
 * Migration: seed `prom_discount_ratio` / `prom_base_price` / `prom_discount_seen_at` on every
 * product variant with a `prom_id`, and correct the prices that are currently inflated.
 *
 * Why this is needed: the price sync used to refuse to touch `price` while a variant was out of
 * stock. That kept a bad price from being written at the moment an item went out of stock, but it
 * also froze whatever price was already stored — and prices written by the legacy scrapers (or by
 * the API sync during a gap between the vendor's promo campaigns) were computed off Prom's
 * *pre-discount* amount, which overstates them by roughly a third. The sync now replays the last
 * discount it saw for a variant, so those frozen prices self-heal — but only once a ratio exists
 * to replay. This script provides it.
 *
 * For each variant:
 *   - Prom reports an active discount  → store the real ratio, recompute `price` from it.
 *   - Prom reports no discount (the out-of-stock case, where Prom withholds it) → fall back to
 *     VENDOR_DEFAULT_RATIO and recompute `price`, so the variant is corrected immediately and the
 *     regular sync can carry it from here.
 *
 * `prom_discount_seen_at` is stamped with the run time, which starts the ratio's 60-day TTL. A
 * variant that never comes back in stock will therefore hold the price computed here once the ratio
 * expires — which is the point: the corrected price, not the inflated one.
 *
 * Usage:
 *   node scripts/migrations/backfill-prom-discount-ratio.js            # dry run, writes nothing
 *   APPLY=true node scripts/migrations/backfill-prom-discount-ratio.js # writes
 */

const axios = require('axios')
const mongoose = require('mongoose')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })

// ── Config ────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL
const PROM_API_KEY = process.env.PROM_API_KEY

if (!DATABASE_URL || !PROM_API_KEY) {
	console.error('DATABASE_URL and PROM_API_KEY must both be set. Check your .env file.')
	process.exit(1)
}

/** Writes only when run as `APPLY=true node scripts/...` — a bare run is always a dry run. */
const DRY_RUN = process.env.APPLY !== 'true'
const CONCURRENCY = 4
const DELAY_MS = 250 // pause per worker between Prom requests

/**
 * Fallback discount for variants Prom currently reports without one.
 *
 * This is the vendor's own rule, not an estimate: it builds the listed pre-discount price by
 * marking the real price up 30%, then discounts back down to it. So the real price is
 * `base / 1.3`, which is a discount of `3/13` (23.0769…%) of the base.
 *
 * It has to be `base / 1.3`, **not** a literal −23%: the two disagree on 670 of the 1212 live
 * ×1.3 discounts in the vendor's catalogue, by 1–2 ₴ each, and only `/ 1.3` reproduces the price
 * Prom actually reports.
 */
const VENDOR_DEFAULT_RATIO = 3 / 13

const PROM_API_BASE = 'https://my.prom.ua/api/v1'
const HTTP_TIMEOUT_MS = 20000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 3000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── Pricing (kept in sync with src/modules/prom/prom-pricing.ts) ──────────────

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

const resolveShopPrice = vendorPrice => Math.round(vendorPrice + getMarkupAmount(vendorPrice))

function parsePromDate(value) {
	if (!value) return null
	const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value).trim())
	if (!m) return null
	const date = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
	return isNaN(date.getTime()) ? null : date
}

function isDiscountActive(discount, now) {
	const start = parsePromDate(discount.date_start)
	if (start && now < start) return false

	const end = parsePromDate(discount.date_end)
	if (end) {
		const endOfDay = new Date(end)
		endOfDay.setHours(23, 59, 59, 999)
		if (now > endOfDay) return false
	}

	return true
}

/** Discount as a fraction of the pre-discount base, or null when the payload has none. */
function ratioFromPayload(base, discount, now) {
	if (!discount) return null

	const value = discount.value
	if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null
	if (!isDiscountActive(discount, now)) return null

	const ratio = discount.type === 'percent' ? value / 100 : value / base
	return ratio > 0 && ratio < 1 ? ratio : null
}

function resolveStock(product) {
	const available =
		product.presence !== undefined
			? product.presence !== 'not_available'
			: product.in_stock !== false
	if (!available) return 0
	const qty = product.quantity_in_stock
	return typeof qty === 'number' && qty > 0 ? qty : 1
}

// ── Prom API ─────────────────────────────────────────────────────────────────

/**
 * Fetch one product, retrying on rate limits and server errors the way `PromService` does. Without
 * the retry a single 429 would drop that variant from the run and silently leave its price
 * uncorrected — and a full-catalogue pass is far more likely to hit the limit than the app's
 * incremental sync.
 */
async function fetchPromProduct(promId) {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const { data } = await axios.get(`${PROM_API_BASE}/products/${promId}`, {
				headers: { Authorization: `Bearer ${PROM_API_KEY}` },
				timeout: HTTP_TIMEOUT_MS
			})
			return data && data.product ? data.product : null
		} catch (err) {
			const status = err.response && err.response.status

			if (status === 404) return null

			const retriable = status === 429 || status === undefined || status >= 500
			if (retriable && attempt < MAX_RETRIES) {
				await sleep(RETRY_DELAY_MS * attempt)
				continue
			}

			throw err
		}
	}

	return null
}

// ── Schema ───────────────────────────────────────────────────────────────────

const ProductVariantSchema = new mongoose.Schema(
	{
		sku: String,
		prom_id: String,
		price: Number,
		stock: Number,
		prom_base_price: Number,
		prom_discount_ratio: Number,
		prom_discount_seen_at: Date,
		price_updated_at: Date
	},
	{ collection: 'product_variants' }
)

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	if (DRY_RUN) console.log('[dry-run] No changes will be written to the database.\n')

	await mongoose.connect(DATABASE_URL)
	console.log('Connected to MongoDB.')

	const ProductVariant = mongoose.model('ProductVariant', ProductVariantSchema)
	const variants = await ProductVariant.find(
		{ prom_id: { $exists: true, $nin: [null, ''] } },
		'_id sku prom_id price stock'
	).lean()

	console.log(`Found ${variants.length} variants with prom_id.\n`)
	if (variants.length === 0) {
		await mongoose.disconnect()
		return
	}

	const results = {
		fromPayload: 0,
		fromDefault: 0,
		lowered: 0,
		raised: 0,
		notFound: 0,
		errors: 0
	}
	let totalDrop = 0
	const now = new Date()

	async function processVariant(i) {
		const variant = variants[i]
		const prefix = `[${i + 1}/${variants.length}] ${variant.sku} (prom_id ${variant.prom_id})`

		let product
		try {
			product = await fetchPromProduct(variant.prom_id)
		} catch (err) {
			console.error(`${prefix} → ERROR: ${err.message}`)
			results.errors++
			return
		}

		if (!product) {
			console.warn(`${prefix} → NOT FOUND on Prom, skipping`)
			results.notFound++
			return
		}

		const base = product.price
		if (typeof base !== 'number' || !isFinite(base) || base <= 0) {
			console.warn(`${prefix} → SKIP (no usable Prom price)`)
			results.notFound++
			return
		}
		if (product.currency && product.currency !== 'UAH') {
			console.warn(`${prefix} → SKIP (currency ${product.currency})`)
			results.notFound++
			return
		}

		const payloadRatio = ratioFromPayload(base, product.discount, now)
		const ratio = payloadRatio !== null ? payloadRatio : VENDOR_DEFAULT_RATIO
		const source = payloadRatio !== null ? 'prom' : 'default'
		const stock = resolveStock(product)

		const newPrice = resolveShopPrice(base * (1 - ratio))
		const prevPrice = variant.price ?? 0
		const delta = newPrice - prevPrice

		console.log(
			`${prefix} → base ${base} ₴, −${(ratio * 100).toFixed(1)}% (${source}), stock ${stock} | ` +
				(delta === 0
					? `${newPrice} ₴ (unchanged)`
					: `${prevPrice} → ${newPrice} ₴ (${delta > 0 ? '+' : ''}${delta})`)
		)

		if (source === 'prom') results.fromPayload++
		else results.fromDefault++
		if (delta < 0) {
			results.lowered++
			totalDrop += -delta
		} else if (delta > 0) {
			results.raised++
		}

		if (!DRY_RUN) {
			const $set = {
				prom_base_price: base,
				prom_discount_ratio: ratio,
				prom_discount_seen_at: now,
				price_updated_at: now
			}
			if (delta !== 0) $set.price = newPrice
			await ProductVariant.updateOne({ _id: variant._id }, { $set })
		}
	}

	let nextIndex = 0
	async function worker() {
		while (nextIndex < variants.length) {
			const i = nextIndex++
			await processVariant(i)
			if (nextIndex < variants.length) await sleep(DELAY_MS)
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, variants.length) }, () => worker())
	)

	console.log('\n── Summary ─────────────────────────────────────')
	console.log(`  Total variants        : ${variants.length}`)
	console.log(`  Ratio from Prom       : ${results.fromPayload}`)
	console.log(`  Ratio from default    : ${results.fromDefault}`)
	console.log(`  Prices lowered        : ${results.lowered} (−${totalDrop} ₴ in total)`)
	console.log(`  Prices raised         : ${results.raised}`)
	console.log(`  Not found on Prom     : ${results.notFound}`)
	console.log(`  Errors                : ${results.errors}`)
	if (results.raised > 0) {
		console.log(
			'\n  A raised price means the stored value was BELOW the discounted vendor price.'
		)
		console.log('  Review those lines before running without DRY_RUN.')
	}
	if (DRY_RUN) console.log('\n  [dry-run] No changes were written.')

	await mongoose.disconnect()
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
