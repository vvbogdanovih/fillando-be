/**
 * Fills the copy of the 14 landings seeded by `seed-landings.js` (TD-0002 §5.2.3).
 *
 * `seed-landings.js` deliberately creates every landing as a `draft` with empty
 * `intro_html` / `bottom_html` / `faq` and placeholder `title` / `meta_description`, because an
 * empty SEO page in the index is worse than no page. Writing that copy by hand means 14 pages
 * times six fields through the admin form. This script writes the reviewed copy from
 * `landing-copy.js` instead, so the text lives in git, goes through review like code, and can be
 * re-applied to another database.
 *
 * What it deliberately does NOT do: publish. Status stays `draft` on every landing it touches.
 * Deciding that a page is ready for Google is a human call, and two of the fourteen match no
 * products at all today (see the report).
 *
 * Safety:
 * - Only landings whose copy is still empty are written. Copy typed in the admin is never
 *   overwritten, with or without `--force`.
 * - `title` / `meta_description` are replaced only while they still hold the seed placeholder,
 *   so a hand-tuned title survives a re-run.
 * - Every update pins the values it read in the filter, so a save made in the admin while the
 *   script runs is skipped and reported rather than silently clobbered (no transactions are
 *   available on a standalone MongoDB).
 * - The copy is validated before anything is written: field lengths, allowed HTML tags, and
 *   markup inside FAQ entries. This script writes straight to Mongo and so bypasses the API's
 *   `sanitizeRichText`, which is exactly why it refuses to write anything the sanitizer would
 *   strip.
 * - `--force` only widens the run to landings whose copy is empty but whose title was edited.
 * - `h1` is rewritten from the copy module at the same time, so a landing seeded before the copy
 *   was reviewed picks up the corrected heading. It is pinned in the filter like everything else.
 *
 * Idempotent: a second run reports "Nothing to do."
 *
 * Run AFTER seed-landings.js.
 *
 * Usage:
 *   node scripts/fillando_v_2/fill-landing-copy.js --dry-run
 *   node scripts/fillando_v_2/fill-landing-copy.js
 */

const fs = require('node:fs')
const path = require('node:path')
const mongoose = require('mongoose')

const { CATEGORY_SLUG, defaultsFor, filterConditions } = require('./seed-landings.js')
const { LANDING_COPY } = require('./landing-copy.js')

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

/**
 * Where reports land. `MIGRATION_REPORT_DIR` lets a rehearsal against a production dump write
 * somewhere throwaway, so its output can never be mistaken for — or overwrite — the reports of
 * a real run. Defaults to `scripts/fillando_v_2/reports/`, which is gitignored.
 */
const REPORT_DIR = process.env.MIGRATION_REPORT_DIR || path.join(__dirname, 'reports')
const REPORT_PATH = path.join(REPORT_DIR, 'landing-copy-report.json')

const TITLE_LIMIT = 60
const META_LIMIT = 160

/** Mirrors the allowlist of `sanitizeRichText` (src/common/utils/html.utils.ts). */
const ALLOWED_TAGS = new Set([
	'p',
	'br',
	'h2',
	'h3',
	'h4',
	'strong',
	'b',
	'em',
	'i',
	'ul',
	'ol',
	'li',
	'a',
	'blockquote',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'hr'
])

/** Landing addresses a cross-link may point at, `/{category}/{slug}`. */
function knownPaths() {
	return new Set(LANDING_COPY.map(c => `/${CATEGORY_SLUG}/${c.slug}`))
}

function tagsIn(html) {
	return [...html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)].map(m => m[1].toLowerCase())
}

function linksIn(html) {
	return [...html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1])
}

/**
 * Refuses copy the sanitizer would mangle or Google would truncate. Returns a list of problems;
 * an empty list means the entry is safe to write.
 */
function validate(entry) {
	const problems = []
	const need = ['slug', 'h1', 'title', 'meta_description', 'intro_html', 'bottom_html']
	for (const field of need) {
		if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
			problems.push(`${field} is empty`)
		}
	}
	if (problems.length) return problems

	if (entry.title.length > TITLE_LIMIT) {
		problems.push(`title is ${entry.title.length} chars (limit ${TITLE_LIMIT})`)
	}
	if (entry.meta_description.length > META_LIMIT) {
		problems.push(`meta_description is ${entry.meta_description.length} chars (limit ${META_LIMIT})`)
	}

	for (const field of ['intro_html', 'bottom_html']) {
		for (const tag of tagsIn(entry[field])) {
			if (!ALLOWED_TAGS.has(tag)) problems.push(`${field} uses <${tag}>, which the sanitizer strips`)
		}
	}

	const paths = knownPaths()
	for (const href of linksIn(entry.bottom_html).concat(linksIn(entry.intro_html))) {
		if (href.startsWith('http://') || href.startsWith('https://')) continue
		if (!paths.has(href)) problems.push(`link "${href}" is not a known landing address`)
		if (href === `/${CATEGORY_SLUG}/${entry.slug}`) problems.push(`links to itself (${href})`)
	}

	if (!Array.isArray(entry.faq)) {
		problems.push('faq is not an array')
	} else {
		entry.faq.forEach((item, i) => {
			if (!item || !item.q || !item.a) problems.push(`faq[${i}] has an empty question or answer`)
			else if (/<[a-zA-Z/]/.test(item.q) || /<[a-zA-Z/]/.test(item.a)) {
				problems.push(`faq[${i}] contains markup, which is stripped from FAQ fields`)
			}
		})
	}

	return problems
}

/** How many active variants this landing lists today. */
async function countMatches(db, categoryId, filters) {
	if (!filters || Object.keys(filters).length === 0) return 0
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

function hasCopy(doc) {
	return Boolean(doc.intro_html?.trim() || doc.bottom_html?.trim() || doc.faq?.length)
}

function isPlaceholderMeta(doc) {
	const seeded = defaultsFor({ h1: doc.h1 })
	return doc.title === seeded.title && doc.meta_description === seeded.meta_description
}

async function migrate(db) {
	const category = await db.collection('categories').findOne({ slug: CATEGORY_SLUG })
	if (!category) {
		console.error(`Category "${CATEGORY_SLUG}" not found — run seed-landings.js first.`)
		return false
	}
	console.log(`Category "${category.name}" (${category._id}).`)

	const invalid = []
	for (const entry of LANDING_COPY) {
		const problems = validate(entry)
		if (problems.length) invalid.push({ slug: entry.slug, problems })
	}
	if (invalid.length) {
		console.error('\nThe copy module is invalid — nothing was written:')
		for (const { slug, problems } of invalid) {
			for (const p of problems) console.error(`  ✗ ${slug}: ${p}`)
		}
		return false
	}
	console.log(`Copy validated: ${LANDING_COPY.length} entries, no problems.`)

	const landings = db.collection('landings')
	const plan = []
	const report = { generated_for: db.databaseName, dry_run: DRY_RUN, landings: [] }

	console.log('\nPlan:')
	for (const entry of LANDING_COPY) {
		const doc = await landings.findOne({ category_id: category._id, slug: entry.slug })
		const matches = doc ? await countMatches(db, category._id, doc.filters) : 0
		const row = { slug: entry.slug, matches, action: null, reason: null }

		if (!doc) {
			row.action = 'skip'
			row.reason = 'landing does not exist — run seed-landings.js first'
			console.log(`  ? /${CATEGORY_SLUG}/${entry.slug} — missing, skipped`)
		} else if (doc.status !== 'draft') {
			row.action = 'skip'
			row.reason = `status is "${doc.status}" — a published page is never rewritten`
			console.log(`  = /${CATEGORY_SLUG}/${entry.slug} — ${doc.status}, left untouched`)
		} else if (hasCopy(doc)) {
			row.action = 'skip'
			row.reason = 'copy already written — hand-written text is never overwritten'
			console.log(`  = /${CATEGORY_SLUG}/${entry.slug} — already has copy, left untouched`)
		} else {
			const metaIsPlaceholder = isPlaceholderMeta(doc)
			if (!metaIsPlaceholder && !FORCE) {
				row.action = 'skip'
				row.reason = 'title/description were edited by hand — re-run with --force to fill the body only'
				console.log(`  = /${CATEGORY_SLUG}/${entry.slug} — edited title, skipped (use --force)`)
			} else {
				row.action = 'fill'
				row.overwrites_meta = metaIsPlaceholder
				const note = matches === 0 ? '  ⚠ matches nothing — must stay draft' : ''
				console.log(
					`  + /${CATEGORY_SLUG}/${entry.slug} — fill copy; ${matches} variant(s)${note}`
				)
				plan.push({ doc, entry, metaIsPlaceholder })
			}
		}
		report.landings.push(row)
	}

	if (plan.length === 0) {
		console.log('\nNothing to do.')
		writeReport(report)
		return true
	}

	if (DRY_RUN) {
		console.log(`\nWould fill copy on ${plan.length} landing(s). Status stays draft on all of them.`)
		console.log('Dry run complete — nothing was changed.')
		writeReport(report)
		return true
	}

	let filled = 0
	const skipped = []
	for (const { doc, entry, metaIsPlaceholder } of plan) {
		const $set = {
			h1: entry.h1,
			intro_html: entry.intro_html,
			bottom_html: entry.bottom_html,
			faq: entry.faq.map(({ q, a }) => ({ q, a })),
			updatedAt: new Date()
		}
		if (metaIsPlaceholder) {
			$set.title = entry.title
			$set.meta_description = entry.meta_description
		}

		// Pin what we read: a save made in the admin between the plan and this write loses the
		// race by being skipped, not by being overwritten.
		const res = await db.collection('landings').updateOne(
			{
				_id: doc._id,
				status: 'draft',
				h1: doc.h1,
				intro_html: doc.intro_html ?? '',
				bottom_html: doc.bottom_html ?? '',
				...(metaIsPlaceholder ? { title: doc.title } : {})
			},
			{ $set }
		)

		if (res.matchedCount === 1) {
			filled += 1
		} else {
			skipped.push(entry.slug)
			const row = report.landings.find(r => r.slug === entry.slug)
			if (row) {
				row.action = 'skip'
				row.reason = 'changed in the admin while this script ran — re-run to pick it up'
			}
		}
	}

	console.log(`\nFilled copy on ${filled} landing(s).`)
	if (skipped.length) {
		console.log(`Skipped (edited concurrently, re-run to pick up): ${skipped.join(', ')}`)
	}

	const empty = report.landings.filter(r => r.matches === 0).map(r => r.slug)
	const withCopy = await db.collection('landings').countDocuments({
		category_id: category._id,
		bottom_html: { $ne: '' }
	})

	console.log('\nVerify:')
	const ok = filled + skipped.length === plan.length && skipped.length === 0
	console.log(`  ${ok ? 'OK ' : 'WARN'} landings written: ${filled} of ${plan.length} planned`)
	console.log(`  landings holding copy: ${withCopy} of ${LANDING_COPY.length}`)
	console.log(`  still matching no products: ${empty.length ? empty.join(', ') : 'none'}`)
	console.log(
		'\nAll of them are still draft. Review each one in /admin/landings and publish individually;' +
			'\nnever publish a landing that matches no products.'
	)

	writeReport(report)
	return ok
}

function writeReport(report) {
	try {
		fs.mkdirSync(REPORT_DIR, { recursive: true })
		fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, '\t'))
		console.log(`\nReport: ${path.relative(process.cwd(), REPORT_PATH)}`)
	} catch (err) {
		console.error(`Could not write the report: ${err.message}`)
	}
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

module.exports = { validate, hasCopy, isPlaceholderMeta, ALLOWED_TAGS }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
