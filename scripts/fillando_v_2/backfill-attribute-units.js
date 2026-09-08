/**
 * Migration: give the category's required attributes their unit, and rename «Вага» to
 * «Вага філаменту».
 *
 * The specification table on the product page is supposed to carry a «Вага філаменту» row
 * (Plan-0005 I-27). Two things in the DATA stop it, and no amount of code can close either:
 *
 *   1. The unit lives on the category (`required_attributes[].unit`) and is `null` in every
 *      category — every migration written before this one sets it that way. The products store
 *      the weight as a bare `1` or `3`, so the storefront has nothing to print after the number
 *      and deliberately DROPS the row rather than showing «Вага | 1»
 *      (`fillando-fe/src/app/(root)/products/[slug]/product-attributes.ts`, `UNIT_REQUIRED`).
 *   2. The attribute is labelled «Вага», not «Вага філаменту».
 *
 * The stored VALUE is not converted. This catalogue keeps the net filament weight in kilograms
 * (`backfill-variant-weight.js` reads the same attribute and documents the same rule), and the
 * shop states kilograms everywhere a shopper can see — product names («1,75 мм 1 кг»), the
 * price sheet, the supplier invoices. So the row this step produces reads
 * «Вага філаменту | 1 кг»: the mock spells the same fact as «1000 г», and rewriting 43 products'
 * values to grams to match a mock's spelling would put the data out of step with the names.
 * The shop's own convention wins; the meaning of the row does not change.
 *
 * Order of the two writes matters, and there are no transactions on this standalone MongoDB, so
 * the choice is which half-state a shopper may see. The category (unit AND label) is written
 * FIRST, the products' labels SECOND. Products-first would leave a product labelled
 * «Вага філаменту» whose category still carries no unit — and that is the one combination the
 * storefront hides, so the row would vanish instead of improving. Categories-first leaves at
 * worst «Вага | 1 кг»: correct, visible, merely not yet the mock's wording.
 *
 * Run AFTER `derive-material-taxonomy.js` and `backfill-spool-included.js`: those two decide
 * which required attributes a category has, and a unit can only be written onto an attribute
 * that is already there.
 *
 * Idempotent: a unit already set is never overwritten (an admin may have typed a better one),
 * a label already reading «Вага філаменту» is left alone, and a second run prints
 * "Nothing to do.".
 *
 * Writes go through the raw driver: `updatedAt` is intentionally not touched.
 *
 * Usage:
 *   node scripts/fillando_v_2/backfill-attribute-units.js --dry-run
 *   node scripts/fillando_v_2/backfill-attribute-units.js
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')

// The override table and the label-folding rule, read (never written) from the step that owns
// the JS copy of them. Requiring it has no side effects: it loads dotenv inside `main` only.
const { ATTR_KEY_OVERRIDES, normalizeAttrLabel } = require('./normalize-attr-keys.js')

const DRY_RUN = process.argv.includes('--dry-run')

const REPORT_DIR = process.env.MIGRATION_REPORT_DIR || path.join(__dirname, 'reports')
const REPORT_PATH = path.join(REPORT_DIR, 'attribute-units-report.json')

const CATEGORY_FIELDS = { keyField: 'key', labelField: 'label' }
const PRODUCT_FIELDS = { keyField: 'k', labelField: 'l' }

/**
 * Label → unit, keyed by the normalized label (`normalizeAttrLabel`).
 *
 * Short on purpose. An entry belongs here only when the unit follows from the label AND from the
 * values this catalogue actually stores; anything else is left alone and listed in the report for
 * a person to decide on. «Вага філаменту» is in the table beside «Вага» so this step still
 * recognises the attribute after it has renamed it — that is what makes a second run a no-op.
 *
 * `max_value` is the bound that keeps the unit unambiguous. Weight is the only ambiguous one
 * here: this catalogue writes kilograms (`1`, `3`), and `backfill-variant-weight.js` reads
 * anything above 20 as grams already — so a value above the bound means «кг» is the wrong unit
 * for that category and the attribute is skipped rather than mislabelled by a factor of a
 * thousand.
 */
const UNITS = Object.freeze({
	вага: { unit: 'кг', max_value: 20 },
	'вага філаменту': { unit: 'кг', max_value: 20 },
	діаметр: { unit: 'мм' },
	'температура друку': { unit: '°C' }
})

/** The label the mock's specification table shows, and the one stored today. */
const NEW_LABEL = 'Вага філаменту'
const OLD_LABEL = 'Вага'
const OLD_LABEL_NORMALIZED = normalizeAttrLabel(OLD_LABEL)
const NEW_LABEL_NORMALIZED = normalizeAttrLabel(NEW_LABEL)

/**
 * The key ATTR_KEY_OVERRIDES pins to the NEW label, or null when the table says nothing.
 *
 * The label is the source of the key: `generateAttrKey` transliterates it unless the override
 * table answers first, so «Вага» yields `vaha` and «Вага філаменту» yields `vaha_filamentu`.
 * `CategoryService.mapRequiredAttributes` and `ProductService` recompute the key from the label
 * on EVERY save, so renaming the label without an override entry does not just risk the key — it
 * guarantees the key moves on the next admin save, and the catalogue filters, the landings' pinned
 * filters and the facets are all keyed on `vaha`. On top of that the unit is joined onto the
 * product attribute BY KEY (`product-public.mappers.ts`), so a moved key silently empties the very
 * row this step exists to print.
 *
 * Hence the rename is conditional on the table, not on a flag: it happens only for an entry whose
 * stored key is exactly what the override pins to the new label, which is the same thing as
 * saying the rename cannot move the key. Until that entry is deployed the units are still filled
 * and the rename is reported, not attempted.
 */
const PINNED_KEY = Object.hasOwn(ATTR_KEY_OVERRIDES, NEW_LABEL_NORMALIZED)
	? ATTR_KEY_OVERRIDES[NEW_LABEL_NORMALIZED]
	: null

const MISSING_OVERRIDE =
	`ATTR_KEY_OVERRIDES has no entry for «${NEW_LABEL}», and the label is the source of the key: ` +
	'the next admin save would regenerate `vaha` as `vaha_filamentu` and every filter, landing ' +
	"and facet pinned on `vaha` would stop matching. Add `'вага філаменту': 'vaha'` to " +
	'src/common/utils/attribute.utils.ts, to its mirror in ' +
	'fillando-fe/src/common/utils/slug.utils.ts and to the copy in normalize-attr-keys.js, ' +
	'deploy, then re-run this step — the units it fills do not wait for it.'

const NO_DICTIONARY_ENTRY = 'no unit in the dictionary for this label'

/** A value that states a number and nothing else: `1`, `1,75`, `190–220`. */
const BARE_VALUE = /^\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?$/
const RANGE_SEPARATOR = /\s*[-–—]\s*/

/** Pure: `{ unit, max_value? }` for a label, or null when this step must not guess. */
function unitFor(label) {
	if (typeof label !== 'string') return null
	const normalized = normalizeAttrLabel(label)
	return Object.hasOwn(UNITS, normalized) ? UNITS[normalized] : null
}

/**
 * Pure: the numbers a bare value carries, or null when the value is not bare.
 *
 * A value that already spells its unit («1,75 мм») is not bare, and that matters: the storefront
 * prints `value + unit`, so giving the dimension a unit would render «1,75 мм мм».
 */
function bareNumbers(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? [value] : null
	if (typeof value !== 'string') return null
	const text = value.normalize('NFC').trim()
	if (!BARE_VALUE.test(text)) return null
	const numbers = text
		.split(RANGE_SEPARATOR)
		.map(part => Number(part.trim().replace(',', '.')))
		.filter(n => Number.isFinite(n))
	return numbers.length > 0 ? numbers : null
}

/** Pure: why this unit must not be written for these values, or null when it may be. */
function rejectUnit({ unit, max_value }, values) {
	for (const value of values) {
		const numbers = bareNumbers(value)
		if (numbers === null) {
			return (
				`value ${JSON.stringify(String(value))} already spells its unit, ` +
				`so «${unit}» would be printed twice`
			)
		}
		if (max_value !== undefined && numbers.some(n => n > max_value)) {
			return (
				`value ${JSON.stringify(String(value))} is above ${max_value}, ` +
				`so «${unit}» is not the unit it is stored in`
			)
		}
	}
	return null
}

/**
 * Pure: the category's required attributes with every unit this step can state filled in.
 *
 * @param {unknown} required  `required_attributes` as stored (or anything else)
 * @param {Record<string, unknown[]>} valuesByKey  the distinct values the products of THIS
 *        category carry per attribute key — the evidence `rejectUnit` weighs
 * @returns {{ required_attributes: unknown, filled: object[], skipped: object[], already: object[], changed: boolean }}
 */
function planCategoryUnits(required, valuesByKey = {}) {
	const empty = { filled: [], skipped: [], already: [], changed: false }
	if (!Array.isArray(required)) return { required_attributes: required, ...empty }

	const filled = []
	const skipped = []
	const already = []

	const next = required.map(entry => {
		if (entry === null || typeof entry !== 'object') return entry
		const label = entry.label
		if (typeof label !== 'string') return entry

		if (typeof entry.unit === 'string' && entry.unit.trim() !== '') {
			already.push({ key: entry.key, label, unit: entry.unit })
			return entry
		}

		const wanted = unitFor(label)
		if (!wanted) {
			skipped.push({ key: entry.key, label, reason: NO_DICTIONARY_ENTRY })
			return entry
		}

		const values = Object.hasOwn(valuesByKey, entry.key) ? valuesByKey[entry.key] : []
		const reason = rejectUnit(wanted, values)
		if (reason) {
			skipped.push({ key: entry.key, label, reason })
			return entry
		}

		filled.push({ key: entry.key, label, unit: wanted.unit, values_seen: values.length })
		return { ...entry, unit: wanted.unit }
	})

	return { required_attributes: next, filled, skipped, already, changed: filled.length > 0 }
}

/**
 * Pure: the entries with the «Вага» label rewritten to «Вага філаменту», KEY UNTOUCHED.
 *
 * An entry is renamed only when `pinnedKey` — the key the deployed override table gives the new
 * label — is exactly the key the entry already carries. Anything else is refused and reported:
 * see PINNED_KEY for why moving the key is the one outcome this step may not produce.
 *
 * @param {unknown} entries
 * @param {{ keyField: string, labelField: string }} fields
 * @param {string|null} pinnedKey
 * @returns {{ entries: unknown, renames: object[], blocked: object[], changed: boolean }}
 */
function renameWeightLabel(entries, { keyField, labelField }, pinnedKey) {
	if (!Array.isArray(entries)) return { entries, renames: [], blocked: [], changed: false }

	const renames = []
	const blocked = []

	const next = entries.map(entry => {
		if (entry === null || typeof entry !== 'object') return entry
		const label = entry[labelField]
		if (typeof label !== 'string') return entry
		if (normalizeAttrLabel(label) !== OLD_LABEL_NORMALIZED) return entry

		const key = entry[keyField]
		if (pinnedKey === null) {
			blocked.push({ key, label, reason: MISSING_OVERRIDE })
			return entry
		}
		if (key !== pinnedKey) {
			blocked.push({
				key,
				label,
				reason:
					`stored key ${JSON.stringify(key)} is not ${JSON.stringify(pinnedKey)}, ` +
					`the key the override table pins to «${NEW_LABEL}» — renaming the label ` +
					'here would move the key'
			})
			return entry
		}

		renames.push({ key, from: label, to: NEW_LABEL })
		return { ...entry, [labelField]: NEW_LABEL }
	})

	return { entries: next, renames, blocked, changed: renames.length > 0 }
}

/**
 * Pure: both changes for one category, composed into the single array the write sets.
 * Units go first so the rename sees the finished entries; the dictionary knows both spellings
 * of the label, so the result does not depend on that order.
 */
function planCategory(required, valuesByKey = {}) {
	const units = planCategoryUnits(required, valuesByKey)
	const rename = renameWeightLabel(units.required_attributes, CATEGORY_FIELDS, PINNED_KEY)
	return {
		required_attributes: rename.entries,
		filled: units.filled,
		skipped: units.skipped,
		already: units.already,
		renames: rename.renames,
		blocked: rename.blocked,
		changed: units.changed || rename.changed
	}
}

/** The distinct attribute values each category's products carry, per attribute key. */
function valuesByCategory(productDocs) {
	const byCategory = new Map()
	for (const doc of productDocs) {
		const categoryId = String(doc.category_id)
		if (!byCategory.has(categoryId)) byCategory.set(categoryId, new Map())
		const byKey = byCategory.get(categoryId)
		for (const attr of doc.attributes ?? []) {
			if (attr === null || typeof attr !== 'object' || typeof attr.k !== 'string') continue
			if (!byKey.has(attr.k)) byKey.set(attr.k, new Map())
			// Keyed by its string form so `1` and '1' count once, valued by the original so
			// `rejectUnit` reports what is really stored. First occurrence wins, which keeps the
			// report stable across runs rather than dependent on document order.
			const values = byKey.get(attr.k)
			if (!values.has(String(attr.v))) values.set(String(attr.v), attr.v)
		}
	}
	return byCategory
}

/**
 * `Map<key, Map<string, value>>` → the plain `Record<key, value[]>` the planner takes.
 *
 * `Object.fromEntries` rather than assignment in a loop: it defines own properties, so a key that
 * happens to spell `__proto__` becomes a real entry instead of rewriting the object's prototype.
 */
function toValuesByKey(byKey) {
	return Object.fromEntries(
		[...(byKey ?? new Map())].map(([key, values]) => [key, [...values.values()]])
	)
}

function writeReport(report) {
	fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
	fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
	console.log(`\nReport written to ${REPORT_PATH}`)
}

function printPlan(categoryChanges, productChanges, skippedUnits, blocked) {
	const renamedCategories = categoryChanges.filter(c => c.renames.length > 0).length
	console.log(
		`\nPlan: fill ${categoryChanges.reduce((n, c) => n + c.filled.length, 0)} unit(s) on ` +
			`${categoryChanges.filter(c => c.filled.length > 0).length} category(ies), ` +
			`rename «${OLD_LABEL}» → «${NEW_LABEL}» on ${renamedCategories} category(ies) and ` +
			`${productChanges.length} product(s).`
	)

	for (const change of categoryChanges) {
		for (const f of change.filled) {
			console.log(
				`  category "${change.name}": ${f.key} («${f.label}») unit → «${f.unit}» ` +
					`(${f.values_seen} distinct value(s) seen)`
			)
		}
		for (const r of change.renames) {
			console.log(`  category "${change.name}": ${r.key} label «${r.from}» → «${r.to}»`)
		}
	}
	if (productChanges.length > 0) {
		const keys = new Set(productChanges.flatMap(c => c.renames.map(r => r.key)))
		console.log(
			`  ${productChanges.length} product(s): label «${OLD_LABEL}» → «${NEW_LABEL}» ` +
				`on key(s) ${[...keys].join(', ')}`
		)
	}

	if (skippedUnits.length > 0) {
		console.log(
			`\nLeft without a unit (not guessed at, see the report): ${skippedUnits.length}`
		)
		for (const s of skippedUnits) {
			console.log(`  ${s.category} — ${s.key} («${s.label}»): ${s.reason}`)
		}
	}

	if (blocked.length > 0) {
		// Grouped by reason: the whole point is one actionable instruction, and on this catalogue
		// every entry is blocked by the same missing override — printed once per document it
		// would read 44 times.
		const byReason = new Map()
		for (const b of blocked) {
			if (!byReason.has(b.reason)) byReason.set(b.reason, [])
			byReason.get(b.reason).push(b.where)
		}
		console.warn(
			`\n⚠ The «${OLD_LABEL}» rename is NOT part of the plan for ${blocked.length} entry(ies). ` +
				'Only the label waits — the units above are unaffected.'
		)
		for (const [reason, where] of byReason) {
			console.warn(`\n  ${reason}`)
			console.warn(`  Affects ${where.length}: ${where.slice(0, 5).join('; ')}`)
			if (where.length > 5) console.warn(`  …and ${where.length - 5} more (see the report)`)
		}
	}
}

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
		.project({ _id: 1, name: 1, category_id: 1, attributes: 1 })
		.toArray()
	console.log(`Scanned ${categoryDocs.length} categories and ${productDocs.length} products.`)

	const productValues = valuesByCategory(productDocs)

	const categoryChanges = []
	const skippedUnits = []
	const blocked = []
	for (const doc of categoryDocs) {
		const plan = planCategory(
			doc.required_attributes,
			toValuesByKey(productValues.get(String(doc._id)))
		)
		for (const s of plan.skipped) skippedUnits.push({ category: doc.name, ...s })
		for (const b of plan.blocked) {
			blocked.push({ where: `category "${doc.name}" (${doc._id})`, ...b })
		}
		if (!plan.changed) continue
		categoryChanges.push({
			_id: doc._id,
			name: doc.name,
			original: doc.required_attributes,
			required_attributes: plan.required_attributes,
			filled: plan.filled,
			renames: plan.renames
		})
	}

	const productChanges = []
	for (const doc of productDocs) {
		const plan = renameWeightLabel(doc.attributes, PRODUCT_FIELDS, PINNED_KEY)
		for (const b of plan.blocked) {
			blocked.push({ where: `product "${doc.name}" (${doc._id})`, ...b })
		}
		if (!plan.changed) continue
		productChanges.push({
			_id: doc._id,
			name: doc.name,
			original: doc.attributes,
			attributes: plan.entries,
			renames: plan.renames
		})
	}

	printPlan(categoryChanges, productChanges, skippedUnits, blocked)

	const report = {
		generated_for: db.databaseName,
		dry_run: DRY_RUN,
		categories_scanned: categoryDocs.length,
		products_scanned: productDocs.length,
		override_key_for_new_label: PINNED_KEY,
		units_filled: categoryChanges.flatMap(c => c.filled.map(f => ({ category: c.name, ...f }))),
		units_skipped: skippedUnits,
		label_rename: {
			from: OLD_LABEL,
			to: NEW_LABEL,
			categories: categoryChanges.filter(c => c.renames.length > 0).length,
			products: productChanges.length
		},
		label_rename_blocked: blocked
	}
	writeReport(report)

	if (categoryChanges.length === 0 && productChanges.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	// ---------- 2. Apply: categories first (see the header) ----------
	// The write replaces the whole array, so the filter also pins the array to the value we
	// read. An admin saving the same document between the scan and the write would otherwise
	// lose their edit silently; instead that document is skipped and reported below.
	let skipped = 0
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
			`\nCategories modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${categoryChanges.length} planned).`
		)
	}
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
			`Products modified: ${res.modifiedCount} (matched ${res.matchedCount} of ${productChanges.length} planned).`
		)
	}

	// ---------- 3. Verify ----------
	// Re-plan against the written state: anything this step could still fill or rename means the
	// write did not land. A rename the override table refuses is not counted here — it is the
	// warning above, and it must not stop the chain the units travel in.
	const afterCategories = await categories
		.find({})
		.project({ _id: 1, required_attributes: 1 })
		.toArray()
	const afterProducts = await products
		.find({})
		.project({ _id: 1, category_id: 1, attributes: 1 })
		.toArray()
	const afterValues = valuesByCategory(afterProducts)

	const checks = {
		'required attributes this step can still give a unit': afterCategories.reduce(
			(n, doc) =>
				n +
				planCategory(
					doc.required_attributes,
					toValuesByKey(afterValues.get(String(doc._id)))
				).filled.length,
			0
		),
		[`entries still labelled «${OLD_LABEL}» that the override table allows renaming`]:
			afterCategories.reduce(
				(n, doc) =>
					n +
					renameWeightLabel(doc.required_attributes, CATEGORY_FIELDS, PINNED_KEY).renames
						.length,
				0
			) +
			afterProducts.reduce(
				(n, doc) =>
					n +
					renameWeightLabel(doc.attributes, PRODUCT_FIELDS, PINNED_KEY).renames.length,
				0
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
	UNITS,
	NEW_LABEL,
	OLD_LABEL,
	PINNED_KEY,
	CATEGORY_FIELDS,
	PRODUCT_FIELDS,
	unitFor,
	bareNumbers,
	rejectUnit,
	planCategoryUnits,
	renameWeightLabel,
	planCategory,
	valuesByCategory,
	toValuesByKey
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
