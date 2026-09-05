/**
 * Migration: give every product the `spool_included` attribute and offer it as a filter.
 *
 * `spool_included` ("Котушка в комплекті") describes the format of delivery rather than the
 * polymer, so unlike the other four dimensions it is not derived from `material`
 * (TD-0002 §5.2.1). It has exactly two values: `Так` and `Ні (рефіл)`.
 *
 * The backfill is deliberately symmetric — EVERY product without the attribute gets `Так`,
 * not just the refills. The reason is mechanical: `$elemMatch` can test a value but cannot
 * test for the *absence* of an attribute, so an asymmetric model would leave the filter with a
 * single selectable value and make "show me only spooled filament" impossible to express.
 * `Так` is a statement that is true of the entire current range, so nothing is invented.
 *
 * Order matters and is the opposite of the colour backfill: products are written FIRST and the
 * category filter is added SECOND. This deployment has no transactions (standalone MongoDB),
 * and of the two possible half-states only one is visible to a shopper — a category offering a
 * filter no product carries returns an empty catalogue, while products carrying an attribute
 * no category advertises simply show nothing. So the invisible half-state is the one we risk.
 *
 * Run AFTER derive-material-taxonomy.js, and after deploying ATTR_KEY_OVERRIDES (fd7d898) —
 * otherwise the key is regenerated as `kotushka_v_komplekti` on the next admin save.
 *
 * Idempotent: a product that already has the attribute is left exactly as it is, whatever its
 * value, so a refill already marked `Ні (рефіл)` is never reset to `Так`.
 *
 * Writes go through the raw driver: `updatedAt` is intentionally not touched.
 *
 * Usage:
 *   node scripts/fillando_v_2/backfill-spool-included.js --dry-run
 *   node scripts/fillando_v_2/backfill-spool-included.js
 */

const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

const KEY = 'spool_included'
const LABEL = 'Котушка в комплекті'
const DEFAULT_VALUE = 'Так'
/** The other value, set by hand in the admin for a refill SKU. Never written by this script. */
const REFILL_VALUE = 'Ні (рефіл)'

/**
 * A variant that is a refill rather than a spooled coil. In this database the distinction is
 * carried inside the colour value ("Clear Безбарвний Refill", FL-000253) rather than by a
 * separate product, which is what TD-0002 §5.2.1 assumed. Kept in step with the identically
 * named helper in normalize-variant-colors.js — a spec asserts the two agree.
 */
function isRefillVariant(variant) {
	const fields = [variant && variant.v_value, variant && variant.name]
	return fields.some(f => typeof f === 'string' && /\brefill\b|рефіл/i.test(f))
}

/**
 * Pure: the product's attributes with `spool_included` appended when it is missing.
 * @returns {{ attributes: object[]|null, changed: boolean }}
 */
function withSpoolIncluded(attributes) {
	if (!Array.isArray(attributes)) return { attributes: null, changed: false }
	if (attributes.some(a => a && a.k === KEY)) return { attributes, changed: false }
	return { attributes: [...attributes, { k: KEY, l: LABEL, v: DEFAULT_VALUE }], changed: true }
}

/** Pure: the category's required attributes with `spool_included` offered as a filter. */
function withSpoolFilter(required) {
	if (!Array.isArray(required)) return { required_attributes: null, changed: false }
	if (required.some(a => a && a.key === KEY))
		return { required_attributes: required, changed: false }
	return {
		required_attributes: [
			...required,
			{ key: KEY, label: LABEL, filter_type: 'multi-select', unit: null }
		],
		changed: true
	}
}

async function migrate(db) {
	const products = db.collection('products')
	const categories = db.collection('categories')

	const productDocs = await products
		.find({})
		.project({ _id: 1, name: 1, attributes: 1 })
		.toArray()

	// `spool_included` lives on the product, so it can only describe a product whose variants
	// agree about the packaging. FL-000253 is a refill sitting next to eight spooled colours on
	// one product, so asserting `Так` there would be false — and it would leave the
	// /filament/refill landing permanently empty. Those products are reported, not guessed at.
	const refillVariants = await db
		.collection('product_variants')
		.find({ $or: [{ v_value: /\brefill\b|рефіл/i }, { name: /\brefill\b|рефіл/i }] })
		.project({ _id: 1, sku: 1, name: 1, v_value: 1, product_id: 1 })
		.toArray()
	const mixedProducts = new Map()
	for (const variant of refillVariants) {
		const key = String(variant.product_id)
		if (!mixedProducts.has(key)) mixedProducts.set(key, [])
		mixedProducts.get(key).push(variant)
	}
	// Only categories that already carry the taxonomy get the fifth filter; a category with no
	// filament in it has no use for "котушка в комплекті".
	const categoryDocs = await categories
		.find({ 'required_attributes.key': 'polymer' })
		.project({ _id: 1, name: 1, required_attributes: 1 })
		.toArray()

	console.log(
		`Scanned ${productDocs.length} products and ${categoryDocs.length} filament categories.`
	)

	const productChanges = []
	const existing = new Map()
	for (const doc of productDocs) {
		const current = (doc.attributes ?? []).find(a => a && a.k === KEY)
		if (current) {
			const value = String(current.v)
			existing.set(value, (existing.get(value) ?? 0) + 1)
			continue
		}
		if (mixedProducts.has(String(doc._id))) continue
		const result = withSpoolIncluded(doc.attributes)
		if (!result.changed) continue
		productChanges.push({
			_id: doc._id,
			name: doc.name,
			original: doc.attributes,
			attributes: result.attributes
		})
	}

	const categoryChanges = []
	for (const doc of categoryDocs) {
		const result = withSpoolFilter(doc.required_attributes)
		if (!result.changed) continue
		categoryChanges.push({
			_id: doc._id,
			name: doc.name,
			original: doc.required_attributes,
			required_attributes: result.required_attributes
		})
	}

	console.log(
		`\nPlan: set "${KEY}=${DEFAULT_VALUE}" on ${productChanges.length} products, ` +
			`add the filter to ${categoryChanges.length} categories.`
	)
	if (existing.size > 0) {
		console.log('Already set (left untouched):')
		for (const [value, count] of existing) console.log(`  ${JSON.stringify(value)} — ${count}`)
	}
	if (mixedProducts.size > 0) {
		console.warn(
			`\n⚠ ${mixedProducts.size} product(s) SKIPPED — a refill sits next to spooled variants, ` +
				'so no single product-level value is true:'
		)
		for (const [productId, variants] of mixedProducts) {
			const product = productDocs.find(d => String(d._id) === productId)
			console.warn(`  "${product ? product.name : productId}"`)
			for (const v of variants) {
				console.warn(`    refill variant ${v.sku} — ${JSON.stringify(v.v_value)}`)
			}
		}
		console.warn(
			'  Fix by splitting the refill into its own product (TD-0002 §5.2.1 assumed one), then re-run.'
		)
	}
	for (const change of categoryChanges) {
		console.log(`  category "${change.name}" (${change._id}) gains the "${LABEL}" filter`)
	}

	if (productChanges.length === 0 && categoryChanges.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	if (DRY_RUN) {
		console.log(
			`\nAfter this runs, mark the refill SKU by hand in the admin: "${LABEL}" = "${REFILL_VALUE}".`
		)
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	// ---------- apply: products first (see the header) ----------
	let skipped = 0
	if (productChanges.length > 0) {
		const res = await products.bulkWrite(
			productChanges.map(c => ({
				updateOne: {
					filter: { _id: c._id, attributes: c.original },
					update: { $set: { attributes: c.attributes } }
				}
			}))
		)
		skipped += productChanges.length - res.matchedCount
		console.log(
			`\nProducts modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${productChanges.length} planned).`
		)
	}

	// The filter is only worth offering if every product can answer it. If any product was
	// skipped, the category would advertise a filter that hides those products, so stop here
	// and let the operator re-run.
	if (skipped > 0) {
		console.error(
			`\n${skipped} product(s) changed underneath the migration — the category filter was NOT added. Re-run.`
		)
		return false
	}

	if (categoryChanges.length > 0) {
		const res = await categories.bulkWrite(
			categoryChanges.map(c => ({
				updateOne: {
					filter: { _id: c._id, required_attributes: c.original },
					update: { $set: { required_attributes: c.required_attributes } }
				}
			}))
		)
		skipped += categoryChanges.length - res.matchedCount
		console.log(
			`Categories modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${categoryChanges.length} planned).`
		)
	}

	// ---------- verify ----------
	const skippedIds = [...mixedProducts.keys()].map(id => new mongoose.Types.ObjectId(id))
	const missing = await products.countDocuments({
		'attributes.k': { $ne: KEY },
		_id: { $nin: skippedIds }
	})
	// $and, not two keys in one object: a repeated field name would silently keep only the
	// last condition and the check would always pass.
	const categoriesWithoutFilter = await categories.countDocuments({
		$and: [
			{ 'required_attributes.key': 'polymer' },
			{ 'required_attributes.key': { $ne: KEY } }
		]
	})

	const checks = {
		'products without the attribute, excluding the reported refills': missing,
		'filament categories not offering the filter': categoriesWithoutFilter,
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
			`\nDone. Now mark the refill SKU by hand in the admin: "${LABEL}" = "${REFILL_VALUE}".`
		)
	}
	return !failed
}

async function main() {
	require('dotenv').config()
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
	KEY,
	LABEL,
	DEFAULT_VALUE,
	REFILL_VALUE,
	isRefillVariant,
	withSpoolIncluded,
	withSpoolFilter
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
