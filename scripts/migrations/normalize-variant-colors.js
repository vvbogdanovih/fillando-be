/**
 * Migration: point every colour variant at the colour dictionary.
 *
 * For each variant on a colour axis it writes `color_id`, the denormalized `color_family`,
 * `v_value = color.name_en`, `name = "<product> — <name_uk>"` and a regenerated `slug`
 * (TD-0002 §5.2.2). The previous value is kept in `v_value_legacy` for one release, which is
 * the rollback, and `slug-map.json` records every old → new address.
 *
 * ⚠ ORDER OF DEPLOYMENT — the riskiest step in Plan-0004 (§4, ordering rule 2).
 * This rewrites `v_value` to the ENGLISH name. Today five places on the storefront render
 * `v_value` directly, so running this before Plan-0004 task 12 (backend colour payload) AND
 * task 32 (frontend "Чорний (Black)" rendering) are BOTH in production flips the whole
 * Ukrainian shop to English colour names. Run it on production only after those are live.
 *
 * ⚠ Variant slugs change WITHOUT a 301 — the owner's decision, not to be re-litigated. The
 * map is written anyway, because it costs nothing and leaves the option open if Search Console
 * later shows losses.
 *
 * Anything the dictionary cannot identify with certainty is never guessed at: it is left
 * completely untouched and listed in color-report.json with its variant count, for a human to
 * map by adding a synonym to seed-colors.js (then re-running both).
 *
 * Idempotent: a variant already pointing at the right colour is skipped, and `v_value_legacy`
 * is written only once, so a re-run cannot lose the original spelling.
 *
 * Writes go through the raw driver: `updatedAt` is intentionally not touched.
 *
 * Usage:
 *   node scripts/migrations/normalize-variant-colors.js --dry-run   # report only
 *   node scripts/migrations/normalize-variant-colors.js
 *   node scripts/migrations/normalize-variant-colors.js --force     # apply despite collisions
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')
const { COLORS, normalizeColorValue, aliasesFor } = require('./seed-colors.js')

const DRY_RUN = process.argv.includes('--dry-run')
/** Apply the non-colliding changes even though some slugs collide. Deliberate, never default. */
const FORCE = process.argv.includes('--force')

const REPORT_DIR = path.join(__dirname, 'reports')
const COLOR_REPORT = path.join(REPORT_DIR, 'color-report.json')
const SLUG_MAP = path.join(REPORT_DIR, 'slug-map.json')

/**
 * Copy of `generateSlug` from src/common/utils/attribute.utils.ts. Duplicated rather than
 * imported because this is plain CommonJS run by node, and the slugs it produces must be
 * byte-identical to the ones the API generates on the next save.
 */
const CYRILLIC_MAP = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'h',
	ґ: 'g',
	д: 'd',
	е: 'e',
	є: 'ie',
	ж: 'zh',
	з: 'z',
	и: 'y',
	і: 'i',
	ї: 'i',
	й: 'y',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'kh',
	ц: 'ts',
	ч: 'ch',
	ш: 'sh',
	щ: 'shch',
	ь: '',
	ю: 'iu',
	я: 'ia'
}

function generateSlug(text) {
	return text
		.normalize('NFD')
		.toLowerCase()
		.split('')
		.map(ch => CYRILLIC_MAP[ch] ?? ch)
		.join('')
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}

/**
 * Is this product's variant axis the colour?
 *
 * TD-0002 says `variant_type.key === 'color'`, but the key is derived from the Ukrainian label
 * by `generateAttrKey`, so the stored value in this database is `kolir`. Matching the label as
 * well as either key spelling is what makes the migration work on the real data.
 */
function isColorAxis(variantType) {
	if (!variantType || typeof variantType !== 'object') return false
	const key = typeof variantType.key === 'string' ? variantType.key.toLowerCase() : ''
	if (key === 'color' || key === 'kolir') return true
	const label = typeof variantType.label === 'string' ? variantType.label : ''
	return /колір|кольор|цвет|color/i.test(label)
}

/**
 * @returns Map<alias, color document>
 *
 * Aliases come from the seed definition, not from the stored document: `synonyms` are the
 * irregular spellings this shop's data actually uses and they are deliberately not persisted
 * in the `colors` collection, so indexing the documents alone would miss every one of them.
 * A colour added by hand in the admin still gets its automatic aliases.
 */
function buildIndex(colorDocs) {
	const seedByName = new Map(COLORS.map(c => [c.name_en, c]))
	const index = new Map()
	for (const color of colorDocs) {
		const seed = seedByName.get(color.name_en)
		const source = seed ? { ...color, synonyms: seed.synonyms } : color
		for (const alias of aliasesFor(source)) index.set(alias, color)
	}
	return index
}

/**
 * A refill variant, identified by the marker inside its colour value ("Clear Безбарвний
 * Refill", FL-000253). It is skipped rather than normalized: the colour IS Clear, so matching
 * would rewrite `v_value` to "Clear" and erase the only thing distinguishing this variant from
 * the spooled Clear sitting next to it on the same product. TD-0002 §5.2.1 assumed the refill
 * would be a separate product; until it is, leaving it untouched is the only lossless choice.
 */
function isRefillVariant(variant) {
	const fields = [variant && variant.v_value, variant && variant.name]
	return fields.some(f => typeof f === 'string' && /\brefill\b|рефіл/i.test(f))
}

function matchColor(index, vValue) {
	const normalized = normalizeColorValue(vValue)
	if (!normalized) return null
	return index.get(normalized.toLowerCase()) ?? null
}

function writeJson(file, data) {
	fs.mkdirSync(REPORT_DIR, { recursive: true })
	fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
	console.log(`  ${file}`)
}

/**
 * The slug map records which addresses moved, so it has to survive a re-run: once the
 * migration has been applied there are no pending changes left, and writing that fresh (empty)
 * list over the file would destroy exactly the artefact a rollback needs. Entries are merged
 * and de-duplicated on the old slug instead.
 */
function mergeSlugMap(entries) {
	let previous = []
	if (fs.existsSync(SLUG_MAP)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(SLUG_MAP, 'utf8'))
			if (Array.isArray(parsed)) previous = parsed
		} catch {
			console.warn(`  (existing ${SLUG_MAP} is not readable JSON — starting a new map)`)
		}
	}
	const byFrom = new Map(previous.map(e => [e.from, e]))
	for (const entry of entries) byFrom.set(entry.from, entry)
	return [...byFrom.values()]
}

async function migrate(db) {
	const variants = db.collection('product_variants')
	const products = db.collection('products')
	const colors = db.collection('colors')

	const colorDocs = await colors.find({}).toArray()
	if (colorDocs.length === 0) {
		console.error('The colour dictionary is empty — run seed-colors.js first.')
		return false
	}
	const index = buildIndex(colorDocs)
	console.log(`Dictionary: ${colorDocs.length} colours, ${index.size} recognised spellings.`)

	const productDocs = await products
		.find({})
		.project({ _id: 1, name: 1, variant_type: 1 })
		.toArray()
	const productById = new Map(productDocs.map(p => [String(p._id), p]))

	const variantDocs = await variants
		.find({})
		.project({
			_id: 1,
			product_id: 1,
			name: 1,
			slug: 1,
			v_value: 1,
			v_value_legacy: 1,
			color_id: 1,
			color_family: 1
		})
		.toArray()
	console.log(`Scanned ${variantDocs.length} variants across ${productDocs.length} products.`)

	const changes = []
	const unmatched = new Map()
	const matchedTally = new Map()
	let skippedNoAxis = 0
	let alreadyDone = 0
	const refills = []

	// Slugs are globally unique. Two spellings of one colour on the same product would collapse
	// onto one address, so those are reported instead of written.
	const claimedSlugs = new Map()
	const collisions = []

	for (const variant of variantDocs) {
		const product = productById.get(String(variant.product_id))
		if (!product || !isColorAxis(product.variant_type)) {
			skippedNoAxis++
			continue
		}

		if (isRefillVariant(variant)) {
			refills.push({
				_id: variant._id,
				sku: variant.sku,
				v_value: variant.v_value,
				product: product.name
			})
			continue
		}

		const color = matchColor(index, variant.v_value)
		if (!color) {
			const key =
				variant.v_value === null || variant.v_value === undefined
					? '<null>'
					: String(variant.v_value)
			if (!unmatched.has(key)) unmatched.set(key, { value: key, count: 0, examples: [] })
			const entry = unmatched.get(key)
			entry.count++
			if (entry.examples.length < 5) {
				entry.examples.push({ _id: variant._id, slug: variant.slug, product: product.name })
			}
			continue
		}

		matchedTally.set(color.name_en, (matchedTally.get(color.name_en) ?? 0) + 1)

		const newSlug = generateSlug(`${product.name} ${color.name_en}`)
		const newName = `${product.name} — ${color.name_uk}`

		const owner = claimedSlugs.get(newSlug)
		if (owner && String(owner) !== String(variant._id)) {
			collisions.push({
				slug: newSlug,
				variants: [owner, variant._id],
				product: product.name,
				color: color.name_en
			})
			continue
		}
		claimedSlugs.set(newSlug, variant._id)

		const alreadyCorrect =
			String(variant.color_id ?? '') === String(color._id) &&
			variant.color_family === color.family &&
			variant.v_value === color.name_en &&
			variant.slug === newSlug &&
			variant.name === newName
		if (alreadyCorrect) {
			alreadyDone++
			continue
		}

		changes.push({
			_id: variant._id,
			old_slug: variant.slug,
			new_slug: newSlug,
			set: {
				color_id: color._id,
				color_family: color.family,
				v_value: color.name_en,
				name: newName,
				slug: newSlug,
				// Written once: on a re-run the original spelling is already stored and must not
				// be overwritten with the English name this migration itself wrote.
				...(variant.v_value_legacy === undefined && {
					v_value_legacy: variant.v_value ?? null
				})
			}
		})
	}

	// ---------- plan ----------
	console.log(
		`\nPlan: rewrite ${changes.length} variants; ${alreadyDone} already correct, ` +
			`${skippedNoAxis} not on a colour axis, ${unmatched.size} unmatched spellings.`
	)
	const coverage = [...matchedTally.values()].reduce((a, b) => a + b, 0)
	const considered = coverage + [...unmatched.values()].reduce((a, e) => a + e.count, 0)
	console.log(
		`Coverage: ${coverage}/${considered} colour variants matched ` +
			`(${considered === 0 ? 0 : Math.round((coverage / considered) * 100)}%).`
	)

	if (refills.length > 0) {
		console.warn(
			`\n⚠ ${refills.length} refill variant(s) SKIPPED — normalizing them would erase the marker:`
		)
		for (const r of refills) {
			console.warn(`  ${r.sku} — ${JSON.stringify(r.v_value)} on "${r.product}"`)
		}
		console.warn(
			'  Split the refill into its own product (TD-0002 §5.2.1 assumed one), then re-run.'
		)
	}

	if (collisions.length > 0) {
		console.error(`\n${collisions.length} slug collision(s) — those variants were NOT changed:`)
		for (const c of collisions) {
			console.error(`  ${c.slug} — "${c.product}" / ${c.color}`)
		}
	}

	if (unmatched.size > 0) {
		console.log('\nUnmatched (left untouched — add a synonym to seed-colors.js and re-run):')
		for (const entry of [...unmatched.values()].sort((a, b) => b.count - a.count)) {
			console.log(`  ${JSON.stringify(entry.value)} — ${entry.count} variant(s)`)
		}
	}

	console.log('\nReports:')
	writeJson(COLOR_REPORT, {
		generated_for: db.databaseName,
		dry_run: DRY_RUN,
		variants_scanned: variantDocs.length,
		matched: coverage,
		unmatched_total: considered - coverage,
		matched_by_color: Object.fromEntries([...matchedTally].sort()),
		unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count),
		slug_collisions: collisions,
		skipped_refills: refills
	})
	const moved = changes
		.filter(c => c.old_slug !== c.new_slug)
		.map(c => ({ from: c.old_slug, to: c.new_slug }))
	writeJson(SLUG_MAP, mergeSlugMap(moved))

	if (changes.length === 0) {
		console.log('\nNothing to do.')
		return collisions.length === 0
	}

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		console.log(
			'Review color-report.json before applying, and confirm tasks 12 and 32 are in production.'
		)
		return true
	}

	// A collision means two spellings the dictionary considers one colour sit on the same
	// product — a data question, not something a migration should decide. Writing the rest
	// would leave the shop half-migrated with the interesting cases still pending, so stop.
	if (collisions.length > 0 && !FORCE) {
		console.error(
			`\nAborting: ${collisions.length} slug collision(s). Resolve them (rename a variant, ` +
				'or split the dictionary entry) and re-run. Use --force to apply the rest anyway.'
		)
		return false
	}

	// ---------- apply ----------
	const res = await variants.bulkWrite(
		changes.map(c => ({ updateOne: { filter: { _id: c._id }, update: { $set: c.set } } }))
	)
	console.log(`\nVariants modified: ${res.modifiedCount} (matched ${res.matchedCount}).`)

	// ---------- verify ----------
	const after = await variants
		.find({ color_id: { $ne: null } })
		.project({ color_id: 1, color_family: 1, v_value: 1, v_value_legacy: 1 })
		.toArray()
	const colorById = new Map(colorDocs.map(c => [String(c._id), c]))

	const checks = {
		'variants whose color_family disagrees with the dictionary': after.filter(v => {
			const color = colorById.get(String(v.color_id))
			return !color || color.family !== v.color_family
		}).length,
		'variants whose v_value is not the canonical English name': after.filter(v => {
			const color = colorById.get(String(v.color_id))
			return !color || color.name_en !== v.v_value
		}).length,
		'variants missing the rollback value': after.filter(v => v.v_value_legacy === undefined)
			.length,
		'slug collisions left unresolved': FORCE ? 0 : collisions.length
	}

	console.log('\nVerify:')
	let failed = false
	for (const [label, count] of Object.entries(checks)) {
		const ok = count === 0
		if (!ok) failed = true
		console.log(`  ${ok ? 'OK ' : 'FAIL'} ${label}: ${count}`)
	}
	if (collisions.length > 0) {
		console.warn(
			`\n${collisions.length} slug collision(s) were skipped with --force — they are still listed in color-report.json.`
		)
	}
	if (!failed) {
		console.log('\nDone. Keep v_value_legacy for one release, then a follow-up can drop it.')
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

module.exports = { generateSlug, isColorAxis, isRefillVariant, buildIndex, matchColor }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
