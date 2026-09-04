/**
 * Migration: rename stored attribute keys to their ATTR_KEY_OVERRIDES value.
 *
 * `generateAttrKey(label)` (src/common/utils/attribute.utils.ts) now consults
 * ATTR_KEY_OVERRIDES before transliterating, so catalogue filter dimensions get fixed
 * English keys (`Серія` → `series`, never `seriia`). Keys stored before that change still
 * carry the transliterated form. This script renames them wherever the (normalized) label
 * is in the table but the key is not the override value:
 *   - categories.required_attributes[].key
 *   - products.attributes[].k
 *   - products.variant_type.key
 *
 * The first two are also recomputed from their label by the API on every save, so for them
 * this script only closes the gap until the next save. `variant_type.key` is NOT recomputed
 * (`VariantTypeDto.key` is a plain @IsString() the API stores verbatim), so there the rename
 * is the only thing that keeps it joinable with attributes[].k.
 * Deduplication is narrow: among entries whose key is a rename target in the SAME
 * document, later entries equal to an earlier one on every own property are dropped
 * (so a pre-existing entry already carrying the target key counts too). Multi-valued
 * attributes with different values, and duplicates on other keys, are kept.
 * Nothing else is touched.
 *
 * Idempotent: re-running after a successful migration prints "Nothing to do.".
 *
 * Run AFTER deploying the code that contains ATTR_KEY_OVERRIDES — otherwise the next
 * admin save of a product/category regenerates the transliterated key and reverts this.
 *
 * Writes go through the raw driver: `updatedAt` is intentionally not touched.
 *
 * See TD-0002 §5.2.1 and Plan-0004 PR-0a in the fillando-meta repo.
 *
 * Usage:
 *   node scripts/migrations/normalize-attr-keys.js --dry-run   # print the plan, change nothing
 *   node scripts/migrations/normalize-attr-keys.js             # apply + verify
 *
 * ATTR_KEY_OVERRIDES below must stay identical to `src/common/utils/attribute.utils.ts`;
 * `src/common/utils/normalize-attr-keys.migration.spec.ts` enforces that.
 */

const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

// Keys are already in normalized form (see normalizeAttrLabel).
const ATTR_KEY_OVERRIDES = Object.freeze({
	'тип пластику': 'polymer',
	'ефект поверхні': 'finish',
	армування: 'reinforcement',
	серія: 'series',
	'котушка в комплекті': 'spool_included'
})

const CATEGORY_FIELDS = { keyField: 'key', labelField: 'label' }
const PRODUCT_FIELDS = { keyField: 'k', labelField: 'l' }

/** Lookup form for ATTR_KEY_OVERRIDES: NFC, trimmed, single-spaced, lower-case. */
function normalizeAttrLabel(label) {
	return label.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Deterministic JSON with sorted object keys, so equal entries stringify equally. */
function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	// ObjectId, Date, Decimal128 … — compare by their JSON form.
	if (typeof value.toJSON === 'function') return JSON.stringify(value.toJSON())
	const body = Object.keys(value)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
	return `{${body.join(',')}}`
}

/**
 * Pure: returns a new entries array with overridden keys applied, never mutates input.
 *
 * Deduplication is deliberately narrow — only among entries whose key equals a `to` key
 * produced by a rename in THIS array, later entries exactly equal to an earlier one on
 * every own property are dropped. Multi-valued entries (different `v`) and pre-existing
 * duplicates on unrelated keys are left alone.
 *
 * @param {unknown} entries          `required_attributes` / `attributes` array (or anything else)
 * @param {{ keyField: string, labelField: string }} fields
 * @returns {{ entries: unknown, renames: { label: string, from: unknown, to: string }[], removedDuplicates: number }}
 */
function renameAttributeKeys(entries, { keyField, labelField }) {
	if (!Array.isArray(entries)) return { entries, renames: [], removedDuplicates: 0 }

	const renames = []
	const renamedTo = new Set()
	const renamed = entries.map(entry => {
		if (entry === null || typeof entry !== 'object') return entry
		const label = entry[labelField]
		if (typeof label !== 'string') return entry
		const normalized = normalizeAttrLabel(label)
		if (!Object.hasOwn(ATTR_KEY_OVERRIDES, normalized)) return entry
		const to = ATTR_KEY_OVERRIDES[normalized]
		const from = entry[keyField]
		if (from === to) return entry
		renames.push({ label, from, to })
		renamedTo.add(to)
		return { ...entry, [keyField]: to }
	})

	if (renamedTo.size === 0) return { entries: renamed, renames, removedDuplicates: 0 }

	const seen = new Set()
	let removedDuplicates = 0
	const deduped = []
	for (const entry of renamed) {
		if (entry !== null && typeof entry === 'object' && renamedTo.has(entry[keyField])) {
			const signature = stableStringify(entry)
			if (seen.has(signature)) {
				removedDuplicates++
				continue
			}
			seen.add(signature)
		}
		deduped.push(entry)
	}

	return { entries: deduped, renames, removedDuplicates }
}

/**
 * Pure: the embedded `variant_type` with its key overridden, or the input untouched.
 *
 * @returns {{ variantType: unknown, rename: { label: string, from: unknown, to: string } | null }}
 */
function renameVariantTypeKey(variantType) {
	if (variantType === null || typeof variantType !== 'object' || Array.isArray(variantType)) {
		return { variantType, rename: null }
	}
	const label = variantType.label
	if (typeof label !== 'string') return { variantType, rename: null }
	const normalized = normalizeAttrLabel(label)
	if (!Object.hasOwn(ATTR_KEY_OVERRIDES, normalized)) return { variantType, rename: null }
	const to = ATTR_KEY_OVERRIDES[normalized]
	const from = variantType.key
	if (from === to) return { variantType, rename: null }
	return { variantType: { ...variantType, key: to }, rename: { label, from, to } }
}

/** Same override key under two different labels in one document (e.g. `Серія` + `Series`). */
function findLabelConflicts(entries, { keyField, labelField }) {
	const targets = new Set(Object.values(ATTR_KEY_OVERRIDES))
	const labelsByKey = new Map()
	for (const entry of entries) {
		if (entry === null || typeof entry !== 'object' || !targets.has(entry[keyField])) continue
		if (!labelsByKey.has(entry[keyField])) labelsByKey.set(entry[keyField], new Set())
		labelsByKey.get(entry[keyField]).add(entry[labelField])
	}
	return [...labelsByKey]
		.filter(([, labels]) => labels.size > 1)
		.map(([key, labels]) => ({ key, labels: [...labels] }))
}

/**
 * Runs renameAttributeKeys (and, for products, renameVariantTypeKey) over every document.
 * Returns only the documents that change, each with the exact `$set` to write and the
 * fields to pin in the filter so a concurrent edit is skipped rather than overwritten.
 */
function planCollection(docs, arrayField, fields, { withVariantType = false } = {}) {
	const changes = []
	for (const doc of docs) {
		const result = renameAttributeKeys(doc[arrayField], fields)
		const vt = withVariantType
			? renameVariantTypeKey(doc.variant_type)
			: { variantType: undefined, rename: null }

		const arrayChanged = result.renames.length > 0 || result.removedDuplicates > 0
		if (!arrayChanged && !vt.rename) continue

		const set = {}
		const filter = { _id: doc._id }
		if (arrayChanged) {
			set[arrayField] = result.entries
			filter[arrayField] = doc[arrayField]
		}
		if (vt.rename) {
			set.variant_type = vt.variantType
			filter.variant_type = doc.variant_type
		}

		changes.push({
			_id: doc._id,
			name: doc.name,
			set,
			filter,
			entries: result.entries,
			renames: [...result.renames, ...(vt.rename ? [vt.rename] : [])],
			variantTypeRename: vt.rename,
			removedDuplicates: result.removedDuplicates,
			conflicts: findLabelConflicts(result.entries, fields)
		})
	}
	return changes
}

/** `variant_type.key` entries whose label is in the map but whose key is not the override. */
function countStaleVariantTypes(docs) {
	let stale = 0
	for (const doc of docs) {
		if (renameVariantTypeKey(doc.variant_type).rename) stale++
	}
	return stale
}

/** Entries whose normalized label is in the map but whose key is not the override value. */
function countStaleEntries(docs, arrayField, { keyField, labelField }) {
	let stale = 0
	for (const doc of docs) {
		for (const entry of doc[arrayField] ?? []) {
			if (
				entry === null ||
				typeof entry !== 'object' ||
				typeof entry[labelField] !== 'string'
			)
				continue
			const normalized = normalizeAttrLabel(entry[labelField])
			if (!Object.hasOwn(ATTR_KEY_OVERRIDES, normalized)) continue
			if (entry[keyField] !== ATTR_KEY_OVERRIDES[normalized]) stale++
		}
	}
	return stale
}

function describeRenames(change) {
	const unique = new Map()
	for (const r of change.renames) unique.set(`${r.from}→${r.to}`, `${r.from} → ${r.to}`)
	let text = [...unique.values()].join(', ')
	if (change.variantTypeRename) text += ' (variant axis)'
	if (change.removedDuplicates > 0) {
		const n = change.removedDuplicates
		text += ` (${n} duplicate${n === 1 ? '' : 's'} removed)`
	}
	return text
}

function printPlan(categoryChanges, productChanges) {
	// Per (label, from → to): how many documents of each kind are affected.
	const summary = new Map()
	const tally = (changes, kind) => {
		for (const change of changes) {
			const seenInDoc = new Set()
			for (const r of change.renames) {
				const id = `${JSON.stringify(r.label)}: ${r.from} → ${r.to}`
				if (seenInDoc.has(id)) continue
				seenInDoc.add(id)
				if (!summary.has(id)) summary.set(id, { categories: 0, products: 0 })
				summary.get(id)[kind]++
			}
		}
	}
	tally(categoryChanges, 'categories')
	tally(productChanges, 'products')

	console.log('\nPlan:')
	for (const [id, counts] of summary) {
		console.log(`  ${id} — categories: ${counts.categories}, products: ${counts.products}`)
	}

	console.log('')
	for (const change of categoryChanges) {
		console.log(`  category "${change.name}" (${change._id}): ${describeRenames(change)}`)
	}
	for (const change of productChanges) {
		console.log(`  product "${change.name}" (${change._id}): ${describeRenames(change)}`)
	}

	const warn = (kind, change) => {
		for (const c of change.conflicts) {
			const labels = c.labels.map(l => JSON.stringify(l)).join(', ')
			console.warn(
				`  WARN ${kind} "${change.name}" (${change._id}): key "${c.key}" is used under ${c.labels.length} labels: ${labels}`
			)
		}
	}
	for (const change of categoryChanges) warn('category', change)
	for (const change of productChanges) warn('product', change)
}

/** @returns {Promise<boolean>} true when nothing is left to fix (or nothing was attempted) */
async function migrate(db) {
	const categories = db.collection('categories')
	const products = db.collection('products')

	// ---------- 1. Load + plan ----------
	const categoryDocs = await categories
		.find({})
		.project({ _id: 1, name: 1, required_attributes: 1 })
		.toArray()
	const productDocs = await products
		.find({})
		.project({ _id: 1, name: 1, attributes: 1, variant_type: 1 })
		.toArray()
	console.log(`Scanned ${categoryDocs.length} categories and ${productDocs.length} products.`)

	const categoryChanges = planCollection(categoryDocs, 'required_attributes', CATEGORY_FIELDS)
	const productChanges = planCollection(productDocs, 'attributes', PRODUCT_FIELDS, {
		withVariantType: true
	})

	if (categoryChanges.length === 0 && productChanges.length === 0) {
		console.log('Nothing to do.')
		return true
	}

	printPlan(categoryChanges, productChanges)

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	// ---------- 2. Apply ----------
	// The write replaces the whole array, so the filter also pins the array to the value we
	// read. An admin saving the same document between the scan and the write would otherwise
	// lose their edit silently; instead that document is skipped and reported below.
	console.log('')
	let skipped = 0
	if (categoryChanges.length > 0) {
		const res = await categories.bulkWrite(
			categoryChanges.map(c => ({
				updateOne: { filter: c.filter, update: { $set: c.set } }
			}))
		)
		skipped += categoryChanges.length - res.matchedCount
		console.log(
			`Categories modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${categoryChanges.length} planned).`
		)
	}
	if (productChanges.length > 0) {
		const res = await products.bulkWrite(
			productChanges.map(p => ({
				updateOne: { filter: p.filter, update: { $set: p.set } }
			}))
		)
		skipped += productChanges.length - res.matchedCount
		console.log(
			`Products modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${productChanges.length} planned).`
		)
	}

	// ---------- 3. Verify ----------
	const checks = {
		'categories.required_attributes entries with a stale key': countStaleEntries(
			await categories.find({}).project({ required_attributes: 1 }).toArray(),
			'required_attributes',
			CATEGORY_FIELDS
		),
		'products.attributes entries with a stale key': countStaleEntries(
			await products.find({}).project({ attributes: 1 }).toArray(),
			'attributes',
			PRODUCT_FIELDS
		),
		'products.variant_type with a stale key': countStaleVariantTypes(
			await products.find({}).project({ variant_type: 1 }).toArray()
		),
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
	// Loaded here (not at module level) so requiring this file from a unit test has no side effects.
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
		// Never log the URL itself — it carries credentials.
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
	ATTR_KEY_OVERRIDES,
	normalizeAttrLabel,
	renameAttributeKeys,
	renameVariantTypeKey
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
