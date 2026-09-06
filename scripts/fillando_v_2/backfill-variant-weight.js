/**
 * Migration: give every variant a shipping weight (`weight_g`, grams).
 *
 * The weight feeds three things (TD-0006 §5.2): the delivery estimate on the product page,
 * `weight` in the Product JSON-LD and `g:shipping_weight` in the Google Shopping feed. None of
 * them may guess: a variant this script cannot weigh stays `null`, and every consumer then
 * simply omits the field.
 *
 * Where the number comes from, in order:
 *   1. the product attribute «Вага» — in this catalogue it is the net filament weight in
 *      kilograms (`1`, `3`); a value over 20 is taken to be grams already;
 *   2. otherwise the variant name, then the product name — `1 кг`, `0,5 kg`, `250 г`.
 * To that net weight the spool is added (SPOOL_WEIGHT_G) unless the variant is a refill — by
 * the product's `spool_included = Ні (рефіл)` or by the refill marker in its own name/value
 * (the same test `backfill-spool-included.js` uses). A 3 kg reel gets the same spool figure
 * and a note in the report: its spool is heavier, and the admin should correct it by hand.
 *
 * Only variants whose `weight_g` is still null are written, so a weight typed in the admin is
 * never overwritten and a second run reports "Nothing to do."
 *
 * Writes go through the raw driver: `updatedAt` is intentionally not touched.
 *
 * Usage:
 *   node scripts/fillando_v_2/backfill-variant-weight.js --dry-run
 *   node scripts/fillando_v_2/backfill-variant-weight.js
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')
const REPORT_DIR = process.env.MIGRATION_REPORT_DIR || path.join(__dirname, 'reports')
const REPORT = path.join(REPORT_DIR, 'weight-report.json')

/**
 * An empty 1 kg filament spool from Kingroon / Sunlu / Bambu Lab weighs roughly 200–250 g;
 * 220 is the middle of that range. An assumption, not a measurement — the report says so and
 * the owner verifies a sample in the admin after the run (Plan-0006, task 34).
 */
const SPOOL_WEIGHT_G = 220
/** Above this net weight the spool is not a standard 1 kg reel; the report flags the variant. */
const HEAVY_REEL_NET_G = 1500

const WEIGHT_LABEL = /^(вага|weight|маса|нетто)/i
// No `\b` after the unit: JS word boundaries do not know Cyrillic letters, so `кг\b` never
// matches at the end of a string. A negative lookahead for a following letter does the same job.
const KG_IN_TEXT = /(\d+(?:[.,]\d+)?)\s*(кг|kg)(?![a-zа-яіїє])/i
const G_IN_TEXT = /(\d{2,5})\s*(гр|г|g)(?![a-zа-яіїє])/i
const REFILL_MARKER = /\brefill\b|рефіл/i

const toNumber = value => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null
	if (typeof value !== 'string') return null
	const n = Number(value.replace(',', '.').trim())
	return Number.isFinite(n) ? n : null
}

/** Pure: grams from a text like "… 1,75 мм 1 кг" or "250 г", or null. */
function gramsFromText(text) {
	if (typeof text !== 'string') return null
	const kg = KG_IN_TEXT.exec(text)
	if (kg) return Math.round(Number(kg[1].replace(',', '.')) * 1000)
	const g = G_IN_TEXT.exec(text)
	if (g) return Number(g[1])
	return null
}

/**
 * Pure: the net filament weight in grams and where it was read from, or null.
 * @param {{ attributes?: object[], productName?: string, variantName?: string }} input
 * @returns {{ grams: number, source: 'attribute'|'variant_name'|'product_name' } | null}
 */
function parseNetGrams(input) {
	const attributes = Array.isArray(input.attributes) ? input.attributes : []
	const weightAttr = attributes.find(a => a && typeof a.l === 'string' && WEIGHT_LABEL.test(a.l))
	if (weightAttr) {
		const n = toNumber(weightAttr.v)
		if (n !== null && n > 0) {
			// "1" / "3" are kilograms in this catalogue; anything over 20 can only be grams.
			return { grams: Math.round(n <= 20 ? n * 1000 : n), source: 'attribute' }
		}
		const fromText = gramsFromText(String(weightAttr.v))
		if (fromText) return { grams: fromText, source: 'attribute' }
	}
	const fromVariant = gramsFromText(input.variantName)
	if (fromVariant) return { grams: fromVariant, source: 'variant_name' }
	const fromProduct = gramsFromText(input.productName)
	if (fromProduct) return { grams: fromProduct, source: 'product_name' }
	return null
}

/** Pure: a refill ships without a spool. Product attribute first, variant marker second. */
function isRefill(variant, productAttributes) {
	const attributes = Array.isArray(productAttributes) ? productAttributes : []
	const spool = attributes.find(a => a && a.k === 'spool_included')
	if (spool && String(spool.v) === 'Ні (рефіл)') return true
	const fields = [variant && variant.v_value, variant && variant.name]
	return fields.some(f => typeof f === 'string' && REFILL_MARKER.test(f))
}

/**
 * Pure: the weight to write for one variant, or null when it cannot be known.
 * @returns {{ weight_g: number, net_g: number, spool_g: number, source: string, note: string|null } | null}
 */
function planWeightG({ product, variant }) {
	const net = parseNetGrams({
		attributes: product && product.attributes,
		productName: product && product.name,
		variantName: variant && variant.name
	})
	if (!net) return null
	const refill = isRefill(variant, product && product.attributes)
	const spool_g = refill ? 0 : SPOOL_WEIGHT_G
	const note =
		!refill && net.grams > HEAVY_REEL_NET_G
			? `spool assumed ${SPOOL_WEIGHT_G} g — a ${net.grams / 1000} kg reel is heavier, verify in the admin`
			: null
	return { weight_g: net.grams + spool_g, net_g: net.grams, spool_g, source: net.source, note }
}

async function migrate(db) {
	const products = db.collection('products')
	const variants = db.collection('product_variants')

	const productDocs = await products
		.find({})
		.project({ _id: 1, name: 1, attributes: 1 })
		.toArray()
	const productsById = new Map(productDocs.map(p => [String(p._id), p]))
	// `null` matches both an explicit null and a missing field — variants created before the
	// schema had `weight_g` carry no key at all.
	const pending = await variants
		.find({ weight_g: null })
		.project({ _id: 1, sku: 1, name: 1, v_value: 1, product_id: 1 })
		.toArray()
	const weighed = await variants.countDocuments({ weight_g: { $ne: null } })

	console.log(
		`Scanned ${productDocs.length} products; ${pending.length} variant(s) without a weight, ${weighed} already weighed.`
	)

	const changes = []
	const unmatched = []
	const notes = []
	for (const variant of pending) {
		const product = productsById.get(String(variant.product_id))
		if (!product) {
			unmatched.push({ sku: variant.sku, name: variant.name, reason: 'product not found' })
			continue
		}
		const plan = planWeightG({ product, variant })
		if (!plan) {
			unmatched.push({
				sku: variant.sku,
				name: variant.name,
				reason: 'no weight in «Вага» or the name'
			})
			continue
		}
		if (plan.note) notes.push({ sku: variant.sku, name: variant.name, note: plan.note })
		changes.push({ _id: variant._id, sku: variant.sku, name: variant.name, ...plan })
	}

	const bySource = {}
	for (const c of changes) bySource[c.source] = (bySource[c.source] || 0) + 1
	console.log(
		`\nPlan: set weight_g on ${changes.length} variant(s) ` +
			`(spool ${SPOOL_WEIGHT_G} g added unless refill); sources: ${JSON.stringify(bySource)}.`
	)
	for (const c of changes.slice(0, 8)) {
		console.log(
			`  ${c.sku} — ${c.net_g} g + ${c.spool_g} g spool = ${c.weight_g} g (${c.source})`
		)
	}
	if (changes.length > 8) console.log(`  … and ${changes.length - 8} more (see the report)`)
	if (notes.length > 0) {
		console.warn(`\n⚠ ${notes.length} variant(s) to verify by hand in the admin:`)
		for (const n of notes) console.warn(`  ${n.sku} — ${n.note}`)
	}
	if (unmatched.length > 0) {
		console.warn(`\n⚠ ${unmatched.length} variant(s) left at null — no weight could be read:`)
		for (const u of unmatched) console.warn(`  ${u.sku} — ${u.reason}`)
	}

	fs.mkdirSync(REPORT_DIR, { recursive: true })
	fs.writeFileSync(
		REPORT,
		JSON.stringify(
			{
				generated_at: new Date().toISOString(),
				dry_run: DRY_RUN,
				spool_weight_g: SPOOL_WEIGHT_G,
				planned: changes.length,
				already_weighed: weighed,
				unmatched,
				verify_by_hand: notes,
				rows: changes.map(({ _id, ...rest }) => rest)
			},
			null,
			2
		)
	)
	console.log(`\nReport: ${REPORT}`)

	if (changes.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	// ---------- apply ----------
	const res = await variants.bulkWrite(
		changes.map(c => ({
			updateOne: {
				// Pinned on weight_g still being null: a value typed in the admin mid-run wins.
				filter: { _id: c._id, weight_g: null },
				update: { $set: { weight_g: c.weight_g } }
			}
		}))
	)
	const skipped = changes.length - res.matchedCount
	console.log(
		`\nVariants modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${changes.length} planned).`
	)

	// ---------- verify ----------
	const unmatchedIds = new Set(unmatched.map(u => u.sku))
	const stillNull = await variants.find({ weight_g: null }).project({ sku: 1 }).toArray()
	const unexpectedNull = stillNull.filter(v => !unmatchedIds.has(v.sku)).length
	const negative = await variants.countDocuments({ weight_g: { $lt: 0 } })

	const checks = {
		'variants still without a weight, excluding the reported unmatched': unexpectedNull,
		'variants with a negative weight': negative,
		'documents changed by someone else mid-run (skipped, re-run to fix)': skipped
	}

	console.log('\nVerify:')
	let failed = false
	for (const [label, count] of Object.entries(checks)) {
		const ok = count === 0
		if (!ok) failed = true
		console.log(`  ${ok ? 'OK ' : 'FAIL'} ${label}: ${count}`)
	}
	if (!failed) {
		console.log(
			'\nDone. Open a few variants in the admin and check «Вага, г» — the spool figure is an assumption.'
		)
	}
	return !failed
}

async function main() {
	require('dotenv').config({ quiet: true })
	const DATABASE_URL = process.env.DATABASE_URL
	if (!DATABASE_URL) {
		console.error('DATABASE_URL is not set. Check your .env file.')
		process.exit(1)
	}

	await mongoose.connect(DATABASE_URL)
	let ok = false
	try {
		const db = mongoose.connection.db
		console.log(
			`Connected to MongoDB: database "${db.databaseName}" on ${mongoose.connection.host}.${DRY_RUN ? ' (dry run)' : ''}`
		)
		ok = await migrate(db)
	} finally {
		await mongoose.disconnect()
	}

	if (!ok) {
		console.error('\nVerification FAILED — inspect the database before deploying.')
		process.exit(1)
	}
}

module.exports = {
	SPOOL_WEIGHT_G,
	HEAVY_REEL_NET_G,
	gramsFromText,
	parseNetGrams,
	isRefill,
	planWeightG
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
