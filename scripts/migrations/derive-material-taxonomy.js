/**
 * Migration: derive the catalogue filter dimensions from the `material` attribute.
 *
 * Replaces one 29-entry "material" list with four short filters (TD-0002 §5.2.1). Nothing is
 * deleted: `material` stays on every product as its marketing name, and the derived triplets
 * are appended to `Product.attributes`:
 *
 *   polymer        Тип пластику      PLA, PETG, ABS, ASA, PA6, PET, TPU
 *   finish         Ефект поверхні    Silk, Matte, Rainbow, Glow, …  (multi-valued)
 *   reinforcement  Армування         CF, GF
 *   series         Серія             Standard, High Speed, Plus, Lite
 *
 * Multi-valued dimensions are several entries sharing a key — `PLA Matte Rainbow` yields two
 * `finish` rows — which the catalogue's `$elemMatch: { k, v: { $in } }` already treats as an
 * OR within the dimension.
 *
 * It also does task 17: every category that lists `material` as a required attribute swaps it
 * for the four new ones, so the sidebar stops offering the long list.
 *
 * Run AFTER deploying ATTR_KEY_OVERRIDES (fd7d898) — otherwise the keys written here are
 * regenerated as transliterated Ukrainian on the next admin save and the products drop out of
 * every filter. See scripts/migrations/normalize-attr-keys.js.
 *
 * Idempotent: derived entries are rebuilt from `material` on every run, so a second run is a
 * no-op and a corrected mapping table can simply be re-applied.
 *
 * Writes go through the raw driver: `updatedAt` is intentionally not touched.
 *
 * Usage:
 *   node scripts/migrations/derive-material-taxonomy.js --dry-run   # plan + report only
 *   node scripts/migrations/derive-material-taxonomy.js             # apply + verify
 *
 * Unmatched `material` values are never guessed at: they are listed in
 * scripts/migrations/reports/taxonomy-report.json for a human to decide on.
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

const REPORT_PATH = path.join(__dirname, 'reports', 'taxonomy-report.json')

const KEYS = {
	polymer: 'Тип пластику',
	finish: 'Ефект поверхні',
	reinforcement: 'Армування',
	series: 'Серія'
}

/** The 29 rows of TD-0002 §5.2.1. `finish` is an array because a material can carry two. */
const TAXONOMY = {
	ABS: { polymer: 'ABS', finish: [], reinforcement: null, series: 'Standard' },
	'ABS-GF': { polymer: 'ABS', finish: [], reinforcement: 'GF', series: 'Standard' },
	ASA: { polymer: 'ASA', finish: [], reinforcement: null, series: 'Standard' },
	'PA6 Nylon': { polymer: 'PA6', finish: [], reinforcement: null, series: 'Standard' },
	'PA6-CF': { polymer: 'PA6', finish: [], reinforcement: 'CF', series: 'Standard' },
	'PET-CF': { polymer: 'PET', finish: [], reinforcement: 'CF', series: 'Standard' },
	PETG: { polymer: 'PETG', finish: [], reinforcement: null, series: 'Standard' },
	'PETG High Speed': { polymer: 'PETG', finish: [], reinforcement: null, series: 'High Speed' },
	'PETG-CF': { polymer: 'PETG', finish: [], reinforcement: 'CF', series: 'Standard' },
	PLA: { polymer: 'PLA', finish: [], reinforcement: null, series: 'Standard' },
	'PLA Dual-Silk': {
		polymer: 'PLA',
		finish: ['Dual-Silk'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA Glow': { polymer: 'PLA', finish: ['Glow'], reinforcement: null, series: 'Standard' },
	'PLA Gradient': {
		polymer: 'PLA',
		finish: ['Gradient'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA High Speed': { polymer: 'PLA', finish: [], reinforcement: null, series: 'High Speed' },
	'PLA Lite': { polymer: 'PLA', finish: [], reinforcement: null, series: 'Lite' },
	'PLA Luminous': {
		polymer: 'PLA',
		finish: ['Luminous'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA Matte': { polymer: 'PLA', finish: ['Matte'], reinforcement: null, series: 'Standard' },
	'PLA Matte Rainbow': {
		polymer: 'PLA',
		finish: ['Matte', 'Rainbow'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA Rainbow': { polymer: 'PLA', finish: ['Rainbow'], reinforcement: null, series: 'Standard' },
	'PLA Silk': { polymer: 'PLA', finish: ['Silk'], reinforcement: null, series: 'Standard' },
	'PLA Silk Rainbow': {
		polymer: 'PLA',
		finish: ['Silk', 'Rainbow'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA Silk+': { polymer: 'PLA', finish: ['Silk'], reinforcement: null, series: 'Plus' },
	'PLA Temperature Changing': {
		polymer: 'PLA',
		finish: ['Temperature Changing'],
		reinforcement: null,
		series: 'Standard'
	},
	// "Transparent" describes the colour, not the surface, so it is not a finish — it is meant
	// to be covered by `color.family = transparent` (TD-0002 §5.2.1, note under the table).
	'PLA Transparent Rainbow': {
		polymer: 'PLA',
		finish: ['Rainbow'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA Tri-silk': {
		polymer: 'PLA',
		finish: ['Tri-Silk'],
		reinforcement: null,
		series: 'Standard'
	},
	'PLA+': { polymer: 'PLA', finish: [], reinforcement: null, series: 'Plus' },
	'PLA-CF': { polymer: 'PLA', finish: [], reinforcement: 'CF', series: 'Standard' },
	TPU: { polymer: 'TPU', finish: [], reinforcement: null, series: 'Standard' },
	'Wood PLA': { polymer: 'PLA', finish: ['Wood'], reinforcement: null, series: 'Standard' }
}

/** Case-insensitive index, so 'pla silk' and 'PLA Silk' resolve to the same row. */
const TAXONOMY_INDEX = new Map(Object.entries(TAXONOMY).map(([k, v]) => [k.toLowerCase(), v]))

/**
 * A refill is the same filament without a spool, so it maps to the same taxonomy row — the
 * packaging is described by `spool_included` instead (backfill-spool-included.js). Stripping
 * the suffix here means the first refill SKU does not land in the unmatched report.
 */
function normalizeMaterial(value) {
	if (typeof value !== 'string') return null
	const cleaned = value
		.normalize('NFC')
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/\s*\brefill\b\s*$/i, '')
		.trim()
	return cleaned === '' ? null : cleaned
}

/** @returns {{polymer,finish,reinforcement,series}|null} */
function lookupTaxonomy(materialValue) {
	const normalized = normalizeMaterial(materialValue)
	if (!normalized) return null
	return TAXONOMY_INDEX.get(normalized.toLowerCase()) ?? null
}

/** The derived `{k,l,v}` entries for one taxonomy row, in a stable order. */
function buildDerivedEntries(row) {
	const entries = [{ k: 'polymer', l: KEYS.polymer, v: row.polymer }]
	for (const finish of row.finish) entries.push({ k: 'finish', l: KEYS.finish, v: finish })
	if (row.reinforcement) {
		entries.push({ k: 'reinforcement', l: KEYS.reinforcement, v: row.reinforcement })
	}
	entries.push({ k: 'series', l: KEYS.series, v: row.series })
	return entries
}

const DERIVED_KEYS = new Set(Object.keys(KEYS))

/**
 * Pure: returns the product's attributes with the derived dimensions rebuilt from `material`.
 * Existing derived entries are dropped first, which is what makes a re-run a no-op and lets a
 * corrected mapping simply be re-applied.
 *
 * @returns {{ attributes: object[]|null, material: string|null, matched: boolean }}
 */
function deriveAttributes(attributes) {
	if (!Array.isArray(attributes)) return { attributes: null, material: null, matched: false }

	const material = attributes.find(a => a && a.k === 'material')
	const row = material ? lookupTaxonomy(material.v) : null
	if (!row) {
		return {
			attributes: null,
			material: material ? String(material.v) : null,
			matched: false
		}
	}

	const kept = attributes.filter(a => !(a && DERIVED_KEYS.has(a.k)))
	return {
		attributes: [...kept, ...buildDerivedEntries(row)],
		material: String(material.v),
		matched: true
	}
}

/** Deep equality good enough for `{k,l,v}` rows read straight from the driver. */
function sameAttributes(a, b) {
	if (a.length !== b.length) return false
	return a.every((entry, i) => entry.k === b[i].k && entry.l === b[i].l && entry.v === b[i].v)
}

/** Task 17: `material` stops being a filter, the four derived dimensions take its place. */
function rebuildRequiredAttributes(required) {
	if (!Array.isArray(required)) return null
	if (!required.some(a => a && a.key === 'material')) return null

	const withoutMaterial = required.filter(a => !(a && a.key === 'material'))
	const existing = new Set(withoutMaterial.map(a => a.key))
	const added = Object.entries(KEYS)
		.filter(([key]) => !existing.has(key))
		.map(([key, label]) => ({ key, label, filter_type: 'multi-select', unit: null }))

	return [...withoutMaterial, ...added]
}

function writeReport(report) {
	fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
	fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
	console.log(`\nReport written to ${REPORT_PATH}`)
}

async function migrate(db) {
	const products = db.collection('products')
	const categories = db.collection('categories')

	const productDocs = await products
		.find({})
		.project({ _id: 1, name: 1, attributes: 1 })
		.toArray()
	const categoryDocs = await categories
		.find({})
		.project({ _id: 1, name: 1, required_attributes: 1 })
		.toArray()
	console.log(`Scanned ${productDocs.length} products and ${categoryDocs.length} categories.`)

	const productChanges = []
	const unmatched = new Map()
	const derivedTally = new Map()

	for (const doc of productDocs) {
		const result = deriveAttributes(doc.attributes)
		if (!result.matched) {
			// A product with no `material` at all is not a problem to report — only a value we
			// were asked to map and could not.
			if (result.material !== null) {
				const key = result.material
				if (!unmatched.has(key)) unmatched.set(key, { value: key, count: 0, products: [] })
				const entry = unmatched.get(key)
				entry.count++
				if (entry.products.length < 10)
					entry.products.push({ _id: doc._id, name: doc.name })
			}
			continue
		}

		for (const entry of result.attributes.filter(a => DERIVED_KEYS.has(a.k))) {
			const id = `${entry.k}=${entry.v}`
			derivedTally.set(id, (derivedTally.get(id) ?? 0) + 1)
		}

		if (!sameAttributes(doc.attributes, result.attributes)) {
			productChanges.push({
				_id: doc._id,
				name: doc.name,
				material: result.material,
				original: doc.attributes,
				attributes: result.attributes
			})
		}
	}

	const categoryChanges = []
	for (const doc of categoryDocs) {
		const rebuilt = rebuildRequiredAttributes(doc.required_attributes)
		if (!rebuilt) continue
		categoryChanges.push({
			_id: doc._id,
			name: doc.name,
			original: doc.required_attributes,
			required_attributes: rebuilt
		})
	}

	// ---------- plan ----------
	console.log(
		`\nPlan: derive attributes on ${productChanges.length} products, ` +
			`rewrite required_attributes on ${categoryChanges.length} categories.`
	)
	console.log('\nDerived values:')
	for (const [id, count] of [...derivedTally].sort()) console.log(`  ${id} — ${count} product(s)`)
	for (const change of categoryChanges) {
		console.log(
			`\n  category "${change.name}" (${change._id}): ` +
				`${change.original.map(a => a.key).join(', ')} → ` +
				`${change.required_attributes.map(a => a.key).join(', ')}`
		)
	}
	if (unmatched.size > 0) {
		console.log(
			`\nUnmatched material values (left untouched, see the report): ${unmatched.size}`
		)
		for (const entry of unmatched.values()) {
			console.log(`  ${JSON.stringify(entry.value)} — ${entry.count} product(s)`)
		}
	}

	const report = {
		generated_for: db.databaseName,
		dry_run: DRY_RUN,
		products_scanned: productDocs.length,
		products_to_change: productChanges.length,
		categories_to_change: categoryChanges.length,
		derived_values: Object.fromEntries([...derivedTally].sort()),
		unmatched: [...unmatched.values()]
	}
	writeReport(report)

	if (productChanges.length === 0 && categoryChanges.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	// ---------- apply ----------
	// The filter pins the array we read, so a product saved in the admin between the scan and
	// the write is skipped and reported rather than overwritten.
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
	const afterProducts = await products.find({}).project({ attributes: 1 }).toArray()
	const afterCategories = await categories.find({}).project({ required_attributes: 1 }).toArray()

	const checks = {
		'products whose derived attributes disagree with their material': afterProducts.filter(
			doc => {
				const result = deriveAttributes(doc.attributes)
				return result.matched && !sameAttributes(doc.attributes, result.attributes)
			}
		).length,
		'categories still requiring `material`': afterCategories.filter(doc =>
			(doc.required_attributes ?? []).some(a => a && a.key === 'material')
		).length,
		'documents changed by someone else mid-run (skipped, re-run to fix)': skipped
	}

	console.log('\nVerify:')
	let failed = false
	for (const [label, count] of Object.entries(checks)) {
		const ok = count === 0
		if (!ok) failed = true
		console.log(`  ${ok ? 'OK ' : 'FAIL'} ${label}: ${count}`)
	}
	if (!failed) console.log('\nDone.')
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
	TAXONOMY,
	KEYS,
	normalizeMaterial,
	lookupTaxonomy,
	deriveAttributes,
	rebuildRequiredAttributes
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
