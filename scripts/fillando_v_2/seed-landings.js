/**
 * Seed: the 14 starting landing pages of TD-0002 §5.2.3.
 *
 * Each landing is a category plus a fixed set of catalogue filters and its own copy. They are
 * created as `draft`: the address exists but the public site 404s it until someone writes
 * `intro_html` / `bottom_html` / `faq` in the admin and publishes. That is deliberate — an
 * empty SEO page indexed by Google is worse than no page.
 *
 * Non-destructive and idempotent: a landing that already exists is reported and left exactly
 * as it is, so a re-run never overwrites copy written by hand.
 *
 * The report also counts how many active variants each landing would list. A landing that
 * matches nothing is not an error here, but it must not be published — the plan's acceptance
 * criterion is that all 14 return a non-empty listing.
 *
 * Run AFTER derive-material-taxonomy.js and backfill-spool-included.js: the filters below key
 * off `polymer` / `finish` / `reinforcement` / `spool_included`, which those two create.
 *
 * Usage:
 *   node scripts/fillando_v_2/seed-landings.js --dry-run
 *   node scripts/fillando_v_2/seed-landings.js
 */

const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

const CATEGORY_SLUG = 'filament'

/** TD-0002 §5.2.3, in the order they should appear in the admin list. */
const LANDINGS = [
	{ slug: 'pla', h1: 'PLA філамент', filters: { polymer: ['PLA'] } },
	{ slug: 'petg', h1: 'PETG філамент', filters: { polymer: ['PETG'] } },
	{ slug: 'abs', h1: 'ABS пластик для 3D-друку', filters: { polymer: ['ABS'] } },
	{ slug: 'asa', h1: 'ASA філамент', filters: { polymer: ['ASA'] } },
	{ slug: 'tpu', h1: 'TPU (Flex) філамент', filters: { polymer: ['TPU'] } },
	{ slug: 'nylon', h1: 'Нейлон (PA6) для 3D-друку', filters: { polymer: ['PA6'] } },
	{ slug: 'pla-silk', h1: 'PLA Silk філамент', filters: { polymer: ['PLA'], finish: ['Silk'] } },
	{
		slug: 'pla-matte',
		h1: 'PLA Matte філамент',
		filters: { polymer: ['PLA'], finish: ['Matte'] }
	},
	{ slug: 'carbon', h1: 'Філамент з вуглеволокном', filters: { reinforcement: ['CF'] } },
	{
		slug: 'pla-cf',
		h1: 'PLA-CF філамент',
		filters: { polymer: ['PLA'], reinforcement: ['CF'] }
	},
	{
		slug: 'petg-cf',
		h1: 'PETG-CF філамент',
		filters: { polymer: ['PETG'], reinforcement: ['CF'] }
	},
	{ slug: 'wood', h1: 'Філамент під дерево', filters: { polymer: ['PLA'], finish: ['Wood'] } },
	{ slug: 'glow', h1: 'Філамент, що світиться', filters: { finish: ['Glow', 'Luminous'] } },
	{
		slug: 'refill',
		h1: 'Філамент-рефіл без котушки',
		filters: { spool_included: ['Ні (рефіл)'] }
	}
]

const SITE = 'Fillando'

/** Placeholder metadata: enough to be valid, obviously provisional so nobody ships it as is. */
function defaultsFor(landing) {
	return {
		title: `${landing.h1} — купити в Україні | ${SITE}`,
		meta_description: `${landing.h1}: ціни, наявність, доставка по Україні.`
	}
}

/** The `$elemMatch` conditions one landing's pinned filters translate into. */
function filterConditions(filters) {
	return Object.entries(filters).map(([k, values]) => ({
		'product.attributes': { $elemMatch: { k, v: { $in: values } } }
	}))
}

/** How many active variants this landing would list today. */
async function countMatches(db, categoryId, filters) {
	const [row] = await db
		.collection('product_variants')
		.aggregate([
			{ $match: { category_id: categoryId, status: 'active' } },
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{ $match: { $and: filterConditions(filters) } },
			{ $count: 'n' }
		])
		.toArray()
	return row?.n ?? 0
}

async function migrate(db) {
	const categories = db.collection('categories')
	const landings = db.collection('landings')

	const category = await categories.findOne({ slug: CATEGORY_SLUG })
	if (!category) {
		console.error(`Category "${CATEGORY_SLUG}" not found — nothing to attach landings to.`)
		return false
	}
	console.log(`Category "${category.name}" (${category._id}).`)

	const existing = await landings
		.find({ category_id: category._id })
		.project({ slug: 1, status: 1 })
		.toArray()
	const existingBySlug = new Map(existing.map(doc => [doc.slug, doc]))

	const toInsert = []
	console.log('\nPlan:')
	for (const [index, landing] of LANDINGS.entries()) {
		const matches = await countMatches(db, category._id, landing.filters)
		const already = existingBySlug.get(landing.slug)
		const note = matches === 0 ? '  ⚠ matches nothing — do not publish' : ''

		if (already) {
			console.log(
				`  = /${CATEGORY_SLUG}/${landing.slug} — exists (${already.status}), left untouched; ${matches} variant(s)${note}`
			)
			continue
		}

		console.log(`  + /${CATEGORY_SLUG}/${landing.slug} — ${matches} variant(s)${note}`)
		toInsert.push({
			category_id: category._id,
			slug: landing.slug,
			h1: landing.h1,
			...defaultsFor(landing),
			intro_html: '',
			bottom_html: '',
			faq: [],
			filters: landing.filters,
			price_min: null,
			price_max: null,
			image: null,
			order: index,
			status: 'draft',
			createdAt: new Date(),
			updatedAt: new Date()
		})
	}

	if (toInsert.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	if (DRY_RUN) {
		console.log(`\nWould insert ${toInsert.length} landing(s), all as draft.`)
		console.log('Dry run complete — nothing was changed.')
		return true
	}

	const res = await landings.insertMany(toInsert, { ordered: false })
	console.log(`\nInserted ${res.insertedCount} landing(s) as draft.`)

	const total = await landings.countDocuments({ category_id: category._id })
	const drafts = await landings.countDocuments({ category_id: category._id, status: 'draft' })
	console.log('\nVerify:')
	const ok = total >= LANDINGS.length
	console.log(
		`  ${ok ? 'OK ' : 'FAIL'} landings in the category: ${total} (expected ≥ ${LANDINGS.length})`
	)
	console.log(`  drafts awaiting copy: ${drafts}`)
	if (ok) {
		console.log('\nDone. Write the copy in the admin, then publish each landing individually.')
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

module.exports = { LANDINGS, CATEGORY_SLUG, defaultsFor, filterConditions }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
