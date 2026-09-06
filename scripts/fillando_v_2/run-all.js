/**
 * Runs the catalogue migration chain (TD-0002) in the one order that works.
 *
 * The individual scripts are safe on their own but not interchangeable in order: the taxonomy
 * has to exist before anything filters on it, the refill has to be its own product before the
 * spool backfill can say anything true about its parent, and the colour normalisation must not
 * run until the storefront renders `color` — otherwise the whole shop flips to English colour
 * names. Getting that wrong by hand is easy and the damage is visible to every visitor, so the
 * order lives here rather than in someone's memory.
 *
 * Each step is idempotent and prints its own plan, so the chain can be re-run after a fix.
 *
 * An apply makes TWO passes over the chain, and that is not belt-and-braces. Steps after the
 * taxonomy append attributes to products, and the taxonomy rebuilds its derived entries into a
 * canonical order, so the first pass leaves a handful of products whose attribute array is
 * merely ordered differently from what the taxonomy would write. The second pass settles that
 * and then reports nothing to do — a fixed point, reached without the operator having to know
 * any of this. `--single-pass` opts out.
 *
 * Typical use against a fresh production dump:
 *
 *   node scripts/fillando_v_2/run-all.js --dry-run   # read every plan first
 *   node scripts/fillando_v_2/run-all.js             # apply, stops before colours
 *   # …deploy the frontend, confirm a product page renders `color`…
 *   node scripts/fillando_v_2/run-all.js --colors-only
 *
 * The colour step is held back on purpose. `--include-colors` runs the whole chain including
 * it, and `--colors-only` runs just that step; neither is the default, because the safe answer
 * to "should I run this now?" is no until the frontend is live.
 *
 * Before anything runs it prints which database it is about to change, and an apply on a
 * terminal asks for confirmation first: `yarn migrate` with no override follows `.env`, which on
 * a laptop is the shared dev database rather than production. `--yes` skips the question for
 * non-interactive callers.
 *
 * Exit code is non-zero if any step fails, and the chain stops at the first failure rather than
 * carrying a half-applied state into the next script.
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const DRY_RUN = process.argv.includes('--dry-run')
const INCLUDE_COLORS = process.argv.includes('--include-colors')
const COLORS_ONLY = process.argv.includes('--colors-only')
const SINGLE_PASS = process.argv.includes('--single-pass')
const ASSUME_YES = process.argv.includes('--yes')
/** Applying settles on the second pass; a dry run reads one state and shows one plan. */
const PASSES = DRY_RUN || SINGLE_PASS ? 1 : 2

/**
 * The chain. `holdBack` marks a step that needs a deploy in production before it may run.
 */
const STEPS = [
	{
		script: 'fix-known-data-defects.js',
		what: 'repairs the individually known broken documents, by identity',
		expect: '2 fixes on Kingroon PETG 3 кг (empty material, string category_id); the Candy pair reported'
	},
	{
		script: 'normalize-attr-keys.js',
		what: 'renames attribute keys stored before ATTR_KEY_OVERRIDES existed',
		expect: 'usually "Nothing to do." — a safety net, not a required change'
	},
	{
		script: 'derive-material-taxonomy.js',
		what: 'writes polymer / finish / reinforcement / series from `material`',
		expect: '42 products changed, 1 category, 1 unmatched (Kingroon PETG 3 кг, empty material)'
	},
	{
		script: 'split-refill-products.js',
		what: 'moves each refill variant onto a product of its own',
		expect: '1 product created from FL-000253, parent keeps its spooled variants'
	},
	{
		script: 'backfill-spool-included.js',
		what: 'gives every product `spool_included` and offers it as a filter',
		expect: '42 products changed, 1 category; nothing skipped now the refill is separate'
	},
	{
		script: 'seed-colors.js',
		what: 'inserts the colour dictionary',
		expect: '103 colours; existing entries matched on name_en are left alone'
	},
	{
		script: 'seed-landings.js',
		what: 'creates the 14 landings as drafts',
		expect: '14 inserted; each prints how many variants it would list'
	},
	{
		script: 'fill-landing-copy.js',
		what: 'writes the reviewed landing copy, leaving every landing a draft',
		expect: '14 filled; refill flagged as matching nothing until its product is published'
	},
	{
		script: 'backfill-variant-weight.js',
		what: 'sets weight_g on every variant from «Вага» plus the spool (refills without it)',
		expect: '301 variants weighed from the attribute; 0 unmatched; the 3 kg reel flagged for a manual check'
	},
	{
		script: 'normalize-variant-colors.js',
		what: 'points variants at the colour dictionary and rewrites v_value to the canonical name',
		expect: '291 of 293 matched (99%); only the two "Candy" variants left, 8 variants off the colour axis',
		holdBack:
			'rewrites v_value to the English colour name. Until the storefront renders `color`\n' +
			'   instead of v_value, the whole Ukrainian shop shows English colour names.\n' +
			'   Run it only after the frontend is live and a product page shows "Чорний (Black)".'
	}
]

/**
 * Which database this is about to change, read the way the scripts themselves read it.
 * Printed before anything runs: `yarn migrate` with no override goes wherever `.env` points,
 * and on a laptop that is the shared dev database rather than production.
 */
function target() {
	require('dotenv').config({ quiet: true })
	const url = process.env.DATABASE_URL
	if (!url) return null
	try {
		const parsed = new URL(url)
		const db = parsed.pathname.replace(/^\//, '') || '(default)'
		return { host: parsed.host, db }
	} catch {
		return { host: '(unparsed)', db: '(unparsed)' }
	}
}

/** y/N on a terminal; non-interactive callers pass `--yes` and are never asked. */
function confirm(question) {
	return new Promise(resolve => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
		rl.question(`${question} [y/N] `, answer => {
			rl.close()
			resolve(/^y(es)?$/i.test(answer.trim()))
		})
	})
}

function run(step) {
	const script = path.join(__dirname, step.script)
	const args = DRY_RUN ? [script, '--dry-run'] : [script]
	const res = spawnSync(process.execPath, args, { stdio: 'inherit' })
	if (res.error) {
		console.error(`\nCould not start ${step.script}: ${res.error.message}`)
		return false
	}
	return res.status === 0
}

function banner(index, total, step) {
	const line = '─'.repeat(78)
	console.log(`\n${line}`)
	console.log(`[${index}/${total}] ${step.script}`)
	console.log(`        ${step.what}`)
	console.log(`        expect: ${step.expect}`)
	console.log(line)
}

async function main() {
	const held = STEPS.filter(s => s.holdBack)
	let chain
	if (COLORS_ONLY) chain = held
	else if (INCLUDE_COLORS) chain = STEPS
	else chain = STEPS.filter(s => !s.holdBack)

	if (chain.length === 0) {
		console.error('Nothing to run: --colors-only was given but no step is held back.')
		process.exit(1)
	}

	const where = target()
	if (!where) {
		console.error('DATABASE_URL is not set. Check your .env file.')
		process.exit(1)
	}

	console.log(
		`Catalogue migration chain — ${chain.length} step(s)${DRY_RUN ? ', DRY RUN' : ''}.\n` +
			'Each step is idempotent; the chain stops at the first failure.'
	)
	console.log(`\nTarget: database "${where.db}" on ${where.host}`)

	if (!DRY_RUN && !ASSUME_YES && process.stdin.isTTY) {
		const go = await confirm(`This WRITES to "${where.db}" on ${where.host}. Continue?`)
		if (!go) {
			console.log('Stopped. Nothing was changed.')
			process.exit(0)
		}
	}
	if (!DRY_RUN) {
		console.log('\nRun the dry run first if you have not: --dry-run prints every plan and writes nothing.')
	} else {
		console.log(
			'\nA dry run reads the state as it is now, so a later step shows what it would do BEFORE\n' +
				'the earlier ones have run. Read each plan for its own step, not as a forecast of the whole.'
		)
	}

	let done = []
	for (let pass = 1; pass <= PASSES; pass++) {
		if (PASSES > 1) {
			console.log(`\n${'═'.repeat(78)}`)
			console.log(
				pass === 1
					? `PASS 1 of ${PASSES} — applying`
					: `PASS ${pass} of ${PASSES} — settling; every step below should report nothing to do`
			)
			console.log('═'.repeat(78))
		}
		done = []
		for (const [i, step] of chain.entries()) {
			banner(i + 1, chain.length, step)
			if (!run(step)) {
				console.error(`\n✗ ${step.script} failed on pass ${pass}. Stopped here.`)
				console.error(`  Completed before it: ${done.length ? done.join(', ') : 'none'}`)
				console.error('  Fix the cause and re-run this chain — every step so far is idempotent.')
				process.exit(1)
			}
			done.push(step.script)
		}
	}

	console.log(`\n${'═'.repeat(78)}`)
	console.log(
		`Chain complete: ${done.length} step(s)${DRY_RUN ? ' (dry run)' : ''}` +
			`${PASSES > 1 ? `, ${PASSES} passes` : ''}.`
	)

	if (!COLORS_ONLY && !INCLUDE_COLORS && held.length > 0) {
		console.log('\nHeld back, not run:')
		for (const step of held) console.log(`  • ${step.script} — ${step.holdBack}`)
		console.log('\nWhen the frontend is live, run: node scripts/fillando_v_2/run-all.js --colors-only')
	}

	if (!DRY_RUN) {
		console.log(
			'\nAfter the chain:\n' +
				'  1. Read scripts/fillando_v_2/reports/ — taxonomy, colour, refill split and landing copy.\n' +
				'  2. Set "Матеріал = PETG" on the product the taxonomy report lists as unmatched, re-run step 2.\n' +
				'  3. Check the new refill product in the admin: it inherited its parent description.\n' +
				'  4. Review each landing in /admin/landings and publish the ones that list products.\n' +
				'  5. Work through reports/color-report.json, add synonyms to seed-colors.js, re-run 5 and 8.\n' +
				'  6. Open a few variants in the admin and check «Вага, г» — the spool weight is an assumption.'
		)
	}
}

module.exports = { STEPS }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
