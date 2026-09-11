/**
 * Migration 3k: rename products from their long SEO names to the short names the artboards
 * draw — «Філамент (пластик для 3D принтера) Kingroon PLA Silk Rainbow 1,75 мм 1 кг» becomes
 * «Kingroon PLA Silk Rainbow», so a card reads «Kingroon PLA Silk Rainbow — Золотий (Gold)».
 *
 * The short names come from a committed dictionary, `short-names.js`, keyed by the long name
 * (ids differ between environments; the refill product is created per environment by step 3d
 * with a deterministic name). `--propose` prints a first draft of that dictionary from the
 * strip rule in `proposeShortName`; a person reviews it and commits it. A product that carries
 * the long prefix but has no entry is refused, not guessed at.
 *
 * ⚠ A product rename regenerates every variant slug, and variant slugs change WITHOUT a 301 —
 * the owner's decision (`CATALOG_RELEASE.md` §3j, Plan-0004 §6), recorded twice and confirmed
 * again on 2026-09-06 knowing the figure of 242 indexed addresses. `slug-map.json` is written
 * anyway, merged with the colour step's moves.
 *
 * Runs AFTER `normalize-variant-colors.js` (3j) and shares its hold-back: the variant name is
 * `"<product> — <colour>"`, and this step keeps whatever suffix 3j wrote by replacing only the
 * product-name half. Mirrors `ProductService.planVariantRename` / `applyVariantRename`: slugs are
 * vetted for collisions before the first write, movers are parked on `…-moving-<id>` first so
 * addresses can rotate within a product, and every write pins the value it read.
 *
 * Idempotent: a product already short is `already_done`; a variant left parked by a crashed run
 * is picked up from its parked address. Writes go through the raw driver.
 *
 * Usage:
 *   node scripts/fillando_v_2/rename-products-short.js --propose   # print a draft short-names.js
 *   node scripts/fillando_v_2/rename-products-short.js --dry-run   # plan and report only
 *   node scripts/fillando_v_2/rename-products-short.js             # apply
 *   node scripts/fillando_v_2/rename-products-short.js --force     # apply despite collisions
 *   node scripts/fillando_v_2/rename-products-short.js --rollback reports/rename-report.json
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')
const { generateSlug, mergeSlugMap } = require('./normalize-variant-colors.js')

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')
const PROPOSE = process.argv.includes('--propose')
const ROLLBACK_INDEX = process.argv.indexOf('--rollback')
const ROLLBACK_FILE = ROLLBACK_INDEX >= 0 ? process.argv[ROLLBACK_INDEX + 1] : null

const REPORT_DIR = process.env.MIGRATION_REPORT_DIR || path.join(__dirname, 'reports')
const REPORT_PATH = path.join(REPORT_DIR, 'rename-report.json')
const JOURNAL_PATH = path.join(REPORT_DIR, 'rename-journal.json')
const SLUG_MAP = path.join(REPORT_DIR, 'slug-map.json')

/** The SEO prefix every long name starts with. A name without it is already short. */
const LONG_PREFIX = 'Філамент (пластик для 3D принтера) '

/**
 * Pure: the first draft of a short name. Strips the prefix, the one diameter the shop sells
 * and the default weight; keeps everything else verbatim and in order — «(CoPET)», «(нейлон)»,
 * «(еко-пакування)», « (без котушки)», «для AMS», «15%». A weight other than 1 кг stays, because
 * it is the only thing telling the 3 кг reel from the 1 кг one; dropping it would give two
 * products one name and their variants one address.
 */
function proposeShortName(longName) {
	if (typeof longName !== 'string') return longName
	if (!longName.startsWith(LONG_PREFIX)) return longName
	return longName
		.slice(LONG_PREFIX.length)
		.replace(/\s1,75 мм(?=\s|$)/, '')
		.replace(/\s1 кг(?=\s|$)/, '')
		.replace(/\s+/g, ' ')
		.trim()
}

function isLongName(name) {
	return typeof name === 'string' && name.startsWith(LONG_PREFIX)
}

/** Same three-branch label as `normalize-variant-colors.js` and `ProductService.variantName`. */
function colorLabel(color) {
	const uk = color && typeof color.name_uk === 'string' ? color.name_uk.trim() : ''
	const en = color && typeof color.name_en === 'string' ? color.name_en.trim() : ''
	if (!uk) return en
	if (!en || en === uk) return uk
	return `${uk} (${en})`
}

const parkedSlug = (slug, id) => `${slug}-moving-${String(id)}`
const isParked = variant =>
	typeof variant.slug === 'string' && variant.slug.endsWith(`-moving-${String(variant._id)}`)

/**
 * Pure: what renaming the product does to one variant. The name keeps whatever suffix the
 * colour step wrote by swapping only the product-name half; a variant whose name does not start
 * with the product name (never migrated, or edited by hand) is rebuilt from the dictionary
 * colour, falling back to `v_value`, and counted as `rebuilt`.
 */
function plannedVariant(variant, oldProductName, newProductName, color) {
	const currentName = typeof variant.name === 'string' ? variant.name : ''
	let newName
	let rebuilt = false
	if (currentName.startsWith(oldProductName)) {
		newName = `${newProductName}${currentName.slice(oldProductName.length)}`
	} else {
		const label = color ? colorLabel(color) : variant.v_value
		newName = label ? `${newProductName} — ${label}` : newProductName
		rebuilt = true
	}
	const newSlug = generateSlug(
		variant.v_value ? `${newProductName} ${variant.v_value}` : newProductName
	)
	return {
		_id: variant._id,
		sku: variant.sku,
		old_slug: variant.slug,
		new_slug: newSlug,
		old_name: currentName,
		new_name: newName,
		rebuilt,
		// A variant a crashed run left parked is a mover from its parked address.
		parked: isParked(variant)
	}
}

/**
 * Pure: the whole plan. `products` and `variants` are plain documents, `colorById` maps colour
 * ids to dictionary rows, `shortNames` is the committed map. Collisions are vetted here, before
 * anything is written: within a product (two variants that would share one address — the
 * «Candy» pair of `CATALOG_RELEASE.md` §0) and across products (an address already held by a
 * variant that is not moving, or planned by another product).
 */
function planProducts(products, variants, colorById, shortNames) {
	const variantsByProduct = new Map()
	for (const v of variants) {
		const key = String(v.product_id)
		if (!variantsByProduct.has(key)) variantsByProduct.set(key, [])
		variantsByProduct.get(key).push(v)
	}

	const plan = { renamed: [], already_done: [], unmapped: [], collisions: [], taken: [] }
	const plannedIds = new Set()
	const plannedSlugs = new Map() // new slug → { product, sku }

	for (const product of products) {
		const own = variantsByProduct.get(String(product._id)) ?? []
		// A crash can happen AFTER the product name was saved but BEFORE the variants were
		// unparked. The name alone is not a completion marker.
		const recovering =
			!isLongName(product.name) && own.some(v => isParked(v) || isLongName(v.name))
		if (!isLongName(product.name) && !recovering) {
			plan.already_done.push({ product_id: String(product._id), name: product.name })
			continue
		}
		const shortName = recovering ? product.name : shortNames[product.name]
		if (!shortName) {
			plan.unmapped.push({ product_id: String(product._id), name: product.name })
			continue
		}
		const planned = own.map(v =>
			plannedVariant(v, product.name, shortName, colorById.get(String(v.color_id)))
		)

		const bySlug = new Map()
		for (const p of planned) {
			if (!bySlug.has(p.new_slug)) bySlug.set(p.new_slug, [])
			bySlug.get(p.new_slug).push(p.sku)
		}
		const intra = [...bySlug].filter(([, skus]) => skus.length > 1)
		if (intra.length > 0) {
			for (const [slug, skus] of intra) {
				plan.collisions.push({
					product_id: String(product._id),
					product: product.name,
					slug,
					skus
				})
			}
			continue
		}

		plan.renamed.push({
			product_id: String(product._id),
			old_name: product.name,
			new_name: shortName,
			variants: planned
		})
		for (const p of planned) {
			plannedIds.add(String(p._id))
			plannedSlugs.set(p.new_slug, { product: shortName, sku: p.sku })
		}
	}

	// Cross-product: an address a moving variant wants that another planned variant wants too,
	// or that a variant outside the plan already holds.
	const seen = new Map()
	for (const entry of plan.renamed) {
		for (const p of entry.variants) {
			const holder = seen.get(p.new_slug)
			if (holder && holder !== p.sku) {
				plan.taken.push({
					slug: p.new_slug,
					skus: [holder, p.sku],
					reason: 'planned twice'
				})
			}
			seen.set(p.new_slug, p.sku)
		}
	}
	for (const v of variants) {
		if (plannedIds.has(String(v._id))) continue
		const wanted = plannedSlugs.get(v.slug)
		if (wanted) {
			plan.taken.push({
				slug: v.slug,
				skus: [v.sku, wanted.sku],
				reason: 'held by a variant outside the plan'
			})
		}
	}
	return plan
}

function writeJson(file, data) {
	fs.mkdirSync(REPORT_DIR, { recursive: true })
	fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`)
	fs.renameSync(`${file}.tmp`, file)
	console.log(`  ${file}`)
}

/** Persist original addresses BEFORE any write; never erase them on pass 2 or dry-run. */
function mergeJournal(previous, report) {
	if (previous && previous.generated_for !== report.generated_for)
		throw new Error('Rename journal belongs to another database')
	const entries = new Map((previous?.renamed ?? []).map(e => [e.product_id, e]))
	for (const entry of report.renamed) {
		const original = entries.get(entry.product_id)
		if (!original) entries.set(entry.product_id, entry)
		else {
			const variants = new Map(original.variants.map(v => [String(v._id), v]))
			for (const variant of entry.variants)
				if (!variants.has(String(variant._id))) variants.set(String(variant._id), variant)
			entries.set(entry.product_id, { ...original, variants: [...variants.values()] })
		}
	}
	return { generated_for: report.generated_for, dry_run: false, renamed: [...entries.values()] }
}

function loadShortNames() {
	try {
		// eslint-disable-next-line global-require
		return require('./short-names.js').SHORT_NAMES
	} catch {
		return {}
	}
}

/** Print a draft `short-names.js` from the rule plus the attributes a reviewer wants to see. */
async function propose(db) {
	const products = await db.collection('products').find({}).sort({ name: 1 }).toArray()
	const attr = (p, k) =>
		(p.attributes ?? [])
			.filter(a => a && a.k === k)
			.map(a => String(a.v))
			.join('+')
	const lines = products
		.filter(p => isLongName(p.name))
		.map(p => {
			const comment = [
				attr(p, 'vyrobnyk'),
				attr(p, 'polymer'),
				attr(p, 'finish'),
				attr(p, 'series')
			]
				.filter(Boolean)
				.join(' / ')
			return `\t// attrs: ${comment}\n\t${JSON.stringify(p.name)}: ${JSON.stringify(proposeShortName(p.name))},`
		})
	console.log(
		`// Draft from rename-products-short.js --propose on "${db.databaseName}" — review, then commit as short-names.js`
	)
	console.log('const SHORT_NAMES = {')
	console.log(lines.join('\n'))
	console.log('}\n\nmodule.exports = { SHORT_NAMES }')
	const short = products.filter(p => !isLongName(p.name))
	if (short.length)
		console.error(
			`\n${short.length} product(s) already short, not listed: ${short.map(p => p.name).join('; ')}`
		)
}

async function applyRename(variants, products, entry, moved, skipped) {
	const productId = new mongoose.Types.ObjectId(entry.product_id)
	const currentProduct = await products.findOne({ _id: productId })
	if (!currentProduct || currentProduct.name !== entry.old_name) {
		skipped.push(`product ${entry.product_id}`)
		return
	}
	const movers = entry.variants.filter(p => p.new_slug !== p.old_slug && !p.parked)

	// Phase 1: park every mover, so two variants can swap addresses within the product.
	for (const p of movers) {
		const res = await variants.updateOne(
			{ _id: p._id, slug: p.old_slug },
			{ $set: { slug: parkedSlug(p.new_slug, p._id) } }
		)
		if (res.matchedCount !== 1) {
			skipped.push(p.sku)
			console.warn(`  ! ${p.sku} changed while this ran — skipped, re-run to pick it up`)
		}
	}

	// Phase 2: the product itself, pinned on the name that was read.
	const productRes = await products.updateOne(
		{ _id: productId, name: entry.old_name },
		{ $set: { name: entry.new_name } }
	)
	if (productRes.matchedCount !== 1) {
		const fresh = await products.findOne({ _id: productId }, { projection: { name: 1 } })
		if (!fresh || fresh.name !== entry.new_name) {
			skipped.push(`product ${entry.product_id}`)
			console.warn(`  ! product "${entry.old_name}" changed while this ran — skipped`)
			return
		}
	}

	// Phase 3: final name and slug for everyone, movers from their parked address.
	for (const p of entry.variants) {
		if (skipped.includes(p.sku)) continue
		const from = p.parked
			? p.old_slug
			: p.new_slug !== p.old_slug
				? parkedSlug(p.new_slug, p._id)
				: p.old_slug
		const res = await variants.updateOne(
			{ _id: p._id, slug: from },
			{ $set: { name: p.new_name, slug: p.new_slug } }
		)
		if (res.matchedCount !== 1) {
			skipped.push(p.sku)
			console.warn(`  ! ${p.sku} changed while this ran — skipped, re-run to pick it up`)
			continue
		}
		const originalSlug = p.parked
			? p.old_slug.replace(`-moving-${String(p._id)}`, '')
			: p.old_slug
		if (originalSlug !== p.new_slug) moved.push({ from: originalSlug, to: p.new_slug })
		console.log(`  ${p.sku}: ${originalSlug} → ${p.new_slug}`)
	}
}

async function verify(db, plan) {
	const products = await db
		.collection('products')
		.find({}, { projection: { name: 1 } })
		.toArray()
	const variants = await db
		.collection('product_variants')
		.find({}, { projection: { slug: 1, name: 1, product_id: 1 } })
		.toArray()
	const excused = new Set([...plan.collisions, ...plan.unmapped].map(x => x.product_id))
	const nameById = new Map(products.map(p => [String(p._id), p.name]))
	const slugCount = new Map()
	for (const v of variants) slugCount.set(v.slug, (slugCount.get(v.slug) ?? 0) + 1)

	const checks = {
		'products still carrying the long SEO prefix (outside collisions/unmapped)':
			products.filter(p => isLongName(p.name) && !excused.has(String(p._id))).length,
		'duplicate variant slugs': [...slugCount.values()].filter(n => n > 1).length,
		'variants parked on -moving-': variants.filter(v => v.slug.includes('-moving-')).length,
		'variants whose name does not start with their product name': variants.filter(v => {
			const productName = nameById.get(String(v.product_id))
			return productName && typeof v.name === 'string' && !v.name.startsWith(productName)
		}).length
	}
	console.log('\nVerify:')
	let failed = false
	for (const [label, count] of Object.entries(checks)) {
		const ok = count === 0
		if (!ok) failed = true
		console.log(`  ${ok ? 'OK ' : 'FAIL'} ${label}: ${count}`)
	}
	return !failed
}

async function migrate(db) {
	const productsCol = db.collection('products')
	const variantsCol = db.collection('product_variants')
	const shortNames = loadShortNames()
	if (Object.keys(shortNames).length === 0) {
		console.error(
			'short-names.js is missing or empty — run with --propose, review, commit, then re-run.'
		)
		return false
	}

	const [products, variants, colors] = await Promise.all([
		productsCol.find({}).toArray(),
		variantsCol.find({}).toArray(),
		db.collection('colors').find({}).toArray()
	])
	const colorById = new Map(colors.map(c => [String(c._id), c]))
	const plan = planProducts(products, variants, colorById, shortNames)

	console.log(`\nProducts scanned: ${products.length}`)
	console.log(`  to rename: ${plan.renamed.length}`)
	console.log(`  already short: ${plan.already_done.length}`)
	if (plan.unmapped.length) {
		console.error(`  no short name in short-names.js: ${plan.unmapped.length}`)
		for (const u of plan.unmapped) console.error(`    ${JSON.stringify(u.name)}`)
	}
	if (plan.collisions.length) {
		console.error(
			`  slug collisions inside a product: ${plan.collisions.length} — those products are NOT renamed`
		)
		for (const c of plan.collisions)
			console.error(`    "${c.product}": ${c.skus.join(' + ')} → ${c.slug}`)
	}
	if (plan.taken.length) {
		console.error(`  addresses wanted by two variants across products: ${plan.taken.length}`)
		for (const t of plan.taken)
			console.error(`    ${t.slug}: ${t.skus.join(' + ')} (${t.reason})`)
	}
	for (const entry of plan.renamed) {
		console.log(
			`\n"${entry.old_name}"\n  → "${entry.new_name}" (${entry.variants.length} variants${entry.variants.some(v => v.rebuilt) ? ', some names rebuilt from the dictionary' : ''})`
		)
	}

	const report = {
		generated_for: db.databaseName,
		dry_run: DRY_RUN,
		products_scanned: products.length,
		renamed: plan.renamed,
		already_done: plan.already_done,
		unmapped: plan.unmapped,
		collisions: plan.collisions,
		taken: plan.taken,
		name_rebuilt: plan.renamed.reduce(
			(n, e) => n + e.variants.filter(v => v.rebuilt).length,
			0
		),
		skipped_concurrent_edit: []
	}

	if (plan.renamed.length === 0) {
		console.log('\nReports:')
		writeJson(REPORT_PATH, report)
		console.log('\nNothing to do.')
		return plan.unmapped.length === 0 && plan.collisions.length === 0
	}

	if (DRY_RUN) {
		console.log('\nReports:')
		writeJson(REPORT_PATH, report)
		console.log('\nDry run complete — nothing was changed.')
		return plan.unmapped.length === 0 && plan.collisions.length === 0 && plan.taken.length === 0
	}

	const blocked = plan.unmapped.length > 0 || plan.collisions.length > 0 || plan.taken.length > 0
	if (blocked && !FORCE) {
		console.error(
			'\nAborting: unmapped products, slug collisions or taken addresses above. Resolve them ' +
				'(add the short name, split the colliding variants — see CATALOG_RELEASE.md §0) and re-run. ' +
				'Use --force to rename the clean products anyway.'
		)
		writeJson(REPORT_PATH, report)
		return false
	}
	if (plan.taken.length > 0) {
		console.error(
			'\nRefusing even with --force: a cross-product address clash would write a duplicate slug.'
		)
		writeJson(REPORT_PATH, report)
		return false
	}

	// ---------- apply ----------
	const previous = fs.existsSync(JOURNAL_PATH)
		? JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'))
		: null
	const journal = mergeJournal(previous, report)
	writeJson(JOURNAL_PATH, journal)
	const moved = []
	const skipped = []
	for (const entry of plan.renamed) {
		console.log(`\nRenaming "${entry.old_name}" → "${entry.new_name}"`)
		await applyRename(variantsCol, productsCol, entry, moved, skipped)
	}
	report.skipped_concurrent_edit = skipped

	console.log('\nReports:')
	writeJson(REPORT_PATH, report)
	// The journal retains pre-crash addresses even when a re-run starts on a parked slug.
	const journalMoves = journal.renamed.flatMap(e =>
		e.variants
			.filter(v => v.old_slug !== v.new_slug)
			.map(v => ({ from: v.old_slug, to: v.new_slug }))
	)
	writeJson(SLUG_MAP, mergeSlugMap(journalMoves))

	const ok = await verify(db, plan)
	if (skipped.length) {
		console.warn(
			`\n${skipped.length} document(s) changed while this ran and were skipped — re-run to pick them up.`
		)
	}
	if (ok && skipped.length === 0) {
		console.log(
			'\nDone. Purge the storefront caches and resubmit the sitemap (CATALOG_RELEASE.md §3k).'
		)
	}
	return ok && skipped.length === 0
}

/** Replays a report backwards: every variant and product back to its old name and slug. */
async function rollback(db, file) {
	const report = JSON.parse(fs.readFileSync(file, 'utf8'))
	if (report.generated_for !== db.databaseName || report.dry_run || !report.renamed?.length) {
		throw new Error('Rollback requires a non-empty apply journal for this database')
	}
	if (DRY_RUN) {
		console.log(`Would restore ${report.renamed.length} product(s); nothing was written.`)
		return true
	}
	const variants = db.collection('product_variants')
	const products = db.collection('products')
	let restored = 0
	let failed = false
	for (const entry of report.renamed ?? []) {
		const reverse = {
			product_id: entry.product_id,
			old_name: entry.new_name,
			new_name: entry.old_name,
			variants: entry.variants.map(v => ({
				_id: new mongoose.Types.ObjectId(v._id),
				sku: v.sku,
				old_slug: v.new_slug,
				new_slug: v.old_slug,
				old_name: v.new_name,
				new_name: v.old_name,
				parked: false
			}))
		}
		console.log(`\nRestoring "${entry.new_name}" → "${entry.old_name}"`)
		const moved = []
		const skipped = []
		await applyRename(variants, products, reverse, moved, skipped)
		if (skipped.length) failed = true
		restored += moved.length
	}
	console.log(`\nRestored ${restored} variant address(es).`)
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
		if (PROPOSE) {
			await propose(db)
			ok = true
		} else if (ROLLBACK_FILE) {
			console.log(
				`Connected to MongoDB: database "${db.databaseName}" — rolling back from ${ROLLBACK_FILE}`
			)
			ok = await rollback(db, ROLLBACK_FILE)
		} else {
			console.log(
				`Connected to MongoDB: database "${db.databaseName}" on ${mongoose.connection.host}.${DRY_RUN ? ' (dry run)' : ''}`
			)
			ok = await migrate(db)
		}
	} finally {
		await mongoose.disconnect()
	}
	if (!ok) {
		console.error('\nVerification FAILED — inspect the report before deploying.')
		process.exit(1)
	}
}

module.exports = {
	LONG_PREFIX,
	proposeShortName,
	isLongName,
	colorLabel,
	plannedVariant,
	planProducts,
	parkedSlug,
	mergeJournal,
	applyRename,
	rollback
}

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
