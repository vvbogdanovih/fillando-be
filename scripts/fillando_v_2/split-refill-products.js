/**
 * Migration: give every refill its own product.
 *
 * TD-0002 §5.2.1 assumed a refill would be a product, because `spool_included` sits on the
 * product. This database carries the distinction one level down, inside a variant's colour
 * value: FL-000253 "Clear Безбарвний Refill" lives on the Bambu Lab PETG Translucent product
 * next to eight spooled colours. That single mismatch is what makes three separate things
 * impossible at once — `backfill-spool-included.js` has to skip the product because no
 * product-level value is true of it, the `/filament/refill` landing matches nothing, and the
 * shopper sees no warning that the coil has no spool.
 *
 * This migration moves each refill variant onto a product of its own, named after its parent
 * with a suffix, and marks that product `Котушка в комплекті = Ні (рефіл)`. After it runs, the
 * refill is an ordinary product: the filter describes it, the landing lists it, and the
 * storefront's refill callout has an attribute to key off.
 *
 * The refill marker moves with it. `v_value` loses the word "Refill" because the product name
 * now carries the distinction, and that is deliberate: while the marker sat in the colour
 * value, `normalize-variant-colors.js` had to skip the variant to avoid erasing it, so the
 * refill stayed out of the colour dictionary and out of the swatch filter. Once the marker is
 * on the product, "Clear Безбарвний" is an ordinary colour that step resolves normally. The
 * suffix is `(без котушки)` rather than `Refill` for the same reason: `isRefillVariant` reads
 * the variant name too, and a product named "… Refill" would keep tripping it.
 *
 * Both moves are recorded in `reports/slug-map.json`, the same file the colour migration
 * writes, because a variant's address changes here and there is no 301 (the owner's decision).
 *
 * Order: run AFTER `derive-material-taxonomy.js`, so the new product inherits the derived
 * dimensions from its parent, and BEFORE `backfill-spool-included.js`, so the parent is no
 * longer a mixed product and picks up `Так` in the ordinary way. It also sets `Так` on the
 * parent itself, so the chain is correct even if the backfill already ran.
 *
 * Safety:
 * - Nothing is deleted and no variant is created; one variant changes `product_id`.
 * - Every target slug is checked for a clash BEFORE the first write, the way
 *   `ProductService.assertSlugsAvailable` does, because `slug` is unique and there is no
 *   transaction to roll back a half-applied batch on this standalone MongoDB.
 * - Each update pins the values it read, so a save made in the admin mid-run is skipped and
 *   reported rather than overwritten.
 * - A product whose variants are ALL refills is already separate; it is reported and only its
 *   `spool_included` attribute is set. Its variants are left alone, because renaming a product
 *   nobody asked to rename is not this script's business.
 *
 * Idempotent: a re-run reuses the product it created before, and reports "Nothing to do." once
 * every refill sits on its own product.
 *
 * Usage:
 *   node scripts/fillando_v_2/split-refill-products.js --dry-run
 *   node scripts/fillando_v_2/split-refill-products.js
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')

const { generateSlug, isRefillVariant, mergeSlugMap } = require('./normalize-variant-colors.js')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Where reports land. `MIGRATION_REPORT_DIR` lets a rehearsal against a production dump write
 * somewhere throwaway, so its output can never be mistaken for — or overwrite — the reports of
 * a real run. Defaults to `scripts/fillando_v_2/reports/`, which is gitignored.
 */
const REPORT_DIR = process.env.MIGRATION_REPORT_DIR || path.join(__dirname, 'reports')
const REPORT_PATH = path.join(REPORT_DIR, 'refill-split-report.json')
const SLUG_MAP = path.join(REPORT_DIR, 'slug-map.json')

const SPOOL_KEY = 'spool_included'
const SPOOL_LABEL = 'Котушка в комплекті'
const SPOOLED_VALUE = 'Так'
const REFILL_VALUE = 'Ні (рефіл)'

/** Appended to the parent's name. Must not contain "refill"/"рефіл" — see the header. */
const SUFFIX = ' (без котушки)'

/**
 * Pure: the colour value with the refill marker removed, wherever it sits.
 *
 * `normalizeColorValue` in seed-colors.js only strips a trailing "Refill" and only for
 * matching; this rewrites the stored value, so it also handles the marker in the middle and
 * the Ukrainian spelling. Returns the original when stripping would leave nothing, since a
 * variant with no colour value at all would take the bare product name as its slug.
 */
function stripRefillMarker(value) {
	if (typeof value !== 'string') return value
	const stripped = value
		// `\b` is ASCII-only in JS, so it would never fire beside a Cyrillic letter: the English
		// spelling gets word boundaries and the Ukrainian one does not, exactly as in
		// `isRefillVariant`, which the two other migrations share.
		.replace(/\s*[([]?\s*(?:\brefill\b|рефіл)\s*[)\]]?\s*/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return stripped === '' ? value : stripped
}

/** Pure: the name of the product a parent's refills move onto. */
function refillProductName(parentName) {
	if (typeof parentName !== 'string') return parentName
	return parentName.endsWith(SUFFIX) ? parentName : `${parentName}${SUFFIX}`
}

/** Pure: attributes with `spool_included` forced to `value`, replacing any existing entry. */
function withSpoolValue(attributes, value) {
	const rest = (Array.isArray(attributes) ? attributes : []).filter(a => a && a.k !== SPOOL_KEY)
	return [...rest, { k: SPOOL_KEY, l: SPOOL_LABEL, v: value }]
}

/** Pure: does this product already say what its packaging is? */
function spoolValueOf(attributes) {
	const found = (Array.isArray(attributes) ? attributes : []).find(a => a && a.k === SPOOL_KEY)
	return found ? String(found.v) : null
}

/**
 * Pure: what moving `variant` onto a product called `productName` produces.
 * Mirrors `ProductService`: the name is "<product> — <suffix>" and the slug is built from the
 * product name plus the colour value, so the next ordinary admin save is a no-op.
 */
function plannedVariant(variant, productName) {
	const v_value = stripRefillMarker(variant.v_value)
	return {
		_id: variant._id,
		sku: variant.sku,
		old_slug: variant.slug,
		old_v_value: variant.v_value,
		v_value,
		name: v_value ? `${productName} — ${v_value}` : productName,
		slug: generateSlug(v_value ? `${productName} ${v_value}` : productName)
	}
}

function writeJson(file, data) {
	fs.mkdirSync(REPORT_DIR, { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
	console.log(`  ${path.relative(process.cwd(), file)}`)
}

async function migrate(db) {
	const products = db.collection('products')
	const variants = db.collection('product_variants')

	const allRefills = await variants
		.find({ $or: [{ v_value: /\brefill\b|рефіл/i }, { name: /\brefill\b|рефіл/i }] })
		.project({ _id: 1, sku: 1, name: 1, slug: 1, v_value: 1, product_id: 1 })
		.toArray()

	if (allRefills.length === 0) {
		console.log('No refill variants found — nothing to split.')
		writeJson(REPORT_PATH, { generated_for: db.databaseName, dry_run: DRY_RUN, products: [] })
		return true
	}

	const byProduct = new Map()
	for (const v of allRefills) {
		const key = String(v.product_id)
		if (!byProduct.has(key)) byProduct.set(key, [])
		byProduct.get(key).push(v)
	}

	const parentIds = [...byProduct.keys()].map(id => new mongoose.Types.ObjectId(id))
	const parents = await products.find({ _id: { $in: parentIds } }).toArray()
	const parentById = new Map(parents.map(p => [String(p._id), p]))

	const plans = []
	const alreadySeparate = []
	const report = { generated_for: db.databaseName, dry_run: DRY_RUN, products: [] }

	console.log(`Found ${allRefills.length} refill variant(s) on ${byProduct.size} product(s).\n`)
	console.log('Plan:')

	for (const [productId, refills] of byProduct) {
		const parent = parentById.get(productId)
		if (!parent) {
			console.warn(`  ! variants ${refills.map(r => r.sku).join(', ')} point at a missing product`)
			report.products.push({ product_id: productId, action: 'skip', reason: 'product missing' })
			continue
		}

		const total = await variants.countDocuments({ product_id: parent._id })
		const spooledCount = total - refills.length

		if (spooledCount === 0) {
			const current = spoolValueOf(parent.attributes)
			alreadySeparate.push({ parent, needsAttribute: current !== REFILL_VALUE })
			console.log(
				`  = "${parent.name}" — every variant is a refill, no split needed` +
					(current === REFILL_VALUE ? '' : `; will set "${SPOOL_LABEL}" = "${REFILL_VALUE}"`)
			)
			report.products.push({
				product_id: productId,
				name: parent.name,
				action: current === REFILL_VALUE ? 'skip' : 'mark-only',
				reason: 'all variants are refills'
			})
			continue
		}

		const newName = refillProductName(parent.name)
		const existing = await products.findOne({ name: newName, category_id: parent.category_id })
		const planned = refills.map(v => plannedVariant(v, newName))

		plans.push({ parent, refills, planned, newName, existingProductId: existing?._id ?? null })
		console.log(
			`  + "${parent.name}"\n` +
				`      → new product "${newName}"${existing ? ' (already exists, reused)' : ''}\n` +
				`      → moves ${refills.length} variant(s): ${planned
					.map(p => `${p.sku} ${JSON.stringify(p.old_v_value)} → ${JSON.stringify(p.v_value)}`)
					.join(', ')}\n` +
				`      → parent keeps ${spooledCount} spooled variant(s)`
		)
	}

	// ---------- pre-flight: every target slug must be free ----------
	const clashes = []
	const withinBatch = new Map()
	for (const plan of plans) {
		for (const p of plan.planned) {
			if (withinBatch.has(p.slug)) {
				clashes.push(`${p.sku} and ${withinBatch.get(p.slug)} both want "${p.slug}"`)
			}
			withinBatch.set(p.slug, p.sku)
		}
	}
	const wanted = [...withinBatch.keys()]
	if (wanted.length > 0) {
		const taken = await variants
			.find({ slug: { $in: wanted } })
			.project({ _id: 1, slug: 1, sku: 1 })
			.toArray()
		const movingIds = new Set(plans.flatMap(p => p.planned.map(x => String(x._id))))
		for (const t of taken) {
			if (movingIds.has(String(t._id))) continue
			clashes.push(`"${t.slug}" is already held by ${t.sku}`)
		}
	}
	if (clashes.length > 0) {
		console.error('\nSlug clash — nothing was written:')
		for (const c of clashes) console.error(`  ✗ ${c}`)
		console.error('Resolve the clash (rename the colour or the product) and re-run.')
		return false
	}

	const marks = alreadySeparate.filter(a => a.needsAttribute)
	if (plans.length === 0 && marks.length === 0) {
		console.log('\nNothing to do.')
		writeJson(REPORT_PATH, report)
		return true
	}

	if (DRY_RUN) {
		console.log(`\nWould create ${plans.filter(p => !p.existingProductId).length} product(s), ` +
			`move ${plans.reduce((n, p) => n + p.planned.length, 0)} variant(s), ` +
			`and set "${SPOOL_LABEL}" on ${plans.length + marks.length} product(s).`)
		console.log('Dry run complete — nothing was changed.')
		writeJson(REPORT_PATH, report)
		return true
	}

	// ---------- apply ----------
	const moved = []
	let created = 0
	let movedCount = 0
	const skipped = []

	for (const plan of plans) {
		const { parent, planned, newName } = plan
		let targetId = plan.existingProductId

		if (!targetId) {
			const now = new Date()
			const doc = {
				name: newName,
				category_id: parent.category_id,
				vendor_id: parent.vendor_id,
				attributes: withSpoolValue(parent.attributes, REFILL_VALUE),
				// The only thing that still connects the two after the split: the refill page
				// shows what the spooled version costs and links to it.
				spooled_product_id: parent._id,
				createdAt: now,
				updatedAt: now
			}
			// Copied so the refill is not a blank page on day one; the owner rewrites it after.
			if (parent.description) doc.description = parent.description
			if (parent.variant_type) doc.variant_type = parent.variant_type
			const res = await products.insertOne(doc)
			targetId = res.insertedId
			created += 1
			console.log(`\nCreated product "${newName}" (${targetId}).`)
		} else {
			await products.updateOne(
				{ _id: targetId },
				{
					$set: {
						attributes: withSpoolValue(parent.attributes, REFILL_VALUE),
						spooled_product_id: parent._id
					}
				}
			)
			console.log(`\nReusing product "${newName}" (${targetId}).`)
		}

		for (const p of planned) {
			// Pin what we read: an admin save between the plan and this write loses by being
			// skipped, not by being overwritten.
			const res = await variants.updateOne(
				{ _id: p._id, product_id: parent._id, slug: p.old_slug },
				{
					$set: {
						product_id: targetId,
						v_value: p.v_value,
						name: p.name,
						slug: p.slug,
						updatedAt: new Date()
					}
				}
			)
			if (res.matchedCount === 1) {
				movedCount += 1
				if (p.old_slug !== p.slug) moved.push({ from: p.old_slug, to: p.slug })
				console.log(`  moved ${p.sku}: ${p.old_slug} → ${p.slug}`)
			} else {
				skipped.push(p.sku)
				console.warn(`  ! ${p.sku} changed while this ran — skipped, re-run to pick it up`)
			}
		}

		// The parent is now unambiguously spooled. Said explicitly so the chain is correct even
		// if backfill-spool-included.js already ran and skipped this product as "mixed".
		if (spoolValueOf(parent.attributes) === null) {
			await products.updateOne(
				{ _id: parent._id, attributes: parent.attributes },
				{ $set: { attributes: withSpoolValue(parent.attributes, SPOOLED_VALUE) } }
			)
			console.log(`  parent "${parent.name}" → "${SPOOL_LABEL}" = "${SPOOLED_VALUE}"`)
		}

		report.products.push({
			product_id: String(parent._id),
			name: parent.name,
			action: 'split',
			new_product_id: String(targetId),
			new_product_name: newName,
			variants: planned.map(p => ({
				sku: p.sku,
				from_slug: p.old_slug,
				to_slug: p.slug,
				from_v_value: p.old_v_value,
				to_v_value: p.v_value
			}))
		})
	}

	for (const { parent } of marks) {
		await products.updateOne(
			{ _id: parent._id, attributes: parent.attributes },
			{ $set: { attributes: withSpoolValue(parent.attributes, REFILL_VALUE) } }
		)
		console.log(`\nMarked "${parent.name}" as "${SPOOL_LABEL}" = "${REFILL_VALUE}".`)
	}

	if (moved.length > 0) writeJson(SLUG_MAP, mergeSlugMap(moved))
	writeJson(REPORT_PATH, report)

	// ---------- verify ----------
	const stillMixed = []
	for (const plan of plans) {
		const left = await variants.countDocuments({
			product_id: plan.parent._id,
			$or: [{ v_value: /\brefill\b|рефіл/i }, { name: /\brefill\b|рефіл/i }]
		})
		if (left > 0) stillMixed.push(`${plan.parent.name} (${left} left)`)
	}

	console.log('\nVerify:')
	const ok = skipped.length === 0 && stillMixed.length === 0
	console.log(`  ${skipped.length === 0 ? 'OK ' : 'FAIL'} variants moved: ${movedCount}, skipped: ${skipped.length}`)
	console.log(`  ${stillMixed.length === 0 ? 'OK ' : 'FAIL'} parents left with a refill variant: ${stillMixed.length ? stillMixed.join(', ') : 'none'}`)
	console.log(`  products created: ${created}`)
	if (ok) {
		console.log(
			'\nDone. The refill is a product now: re-run backfill-spool-included.js if it ran before' +
				'\nthis, then check the new product in the admin — it inherited the parent description.'
		)
	}
	return ok
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

	if (!ok) process.exit(1)
}

module.exports = {
	stripRefillMarker,
	refillProductName,
	withSpoolValue,
	spoolValueOf,
	plannedVariant,
	SUFFIX,
	REFILL_VALUE,
	SPOOLED_VALUE
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
