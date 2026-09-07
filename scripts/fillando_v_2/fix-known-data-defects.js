/**
 * Repairs the individually known data defects in the catalogue, by identity rather than by rule.
 *
 * Every other migration in this directory encodes a rule and applies it to whatever it finds.
 * This one is the opposite on purpose: the catalogue is frozen while the TD-0002 work lands (no
 * new products are being added), so the handful of broken documents is a closed, inspected set
 * and can be addressed one by one. That is safer than inventing a general rule from a sample of
 * one, and it fails loudly if reality stops matching what was inspected.
 *
 * Each fix names the document by `_id` AND asserts what it expects to find there. If the
 * document is missing, already fixed, or holds something else, the fix is reported and skipped
 * rather than applied — so re-running is safe and a changed catalogue cannot be quietly
 * mangled.
 *
 * Run FIRST, before the rest of the chain: `derive-material-taxonomy.js` reads `material`, and
 * one of the fixes below is what makes that field readable at all.
 *
 * The two "Candy" variants of Kingroon PLA Silk Rainbow (FL-000157 at ₴890 / prom_id
 * 2693625316, FL-000162 at ₴860 / prom_id 2693886972) were two live Prom listings that arrived
 * with the same colour name. The owner told them apart on 2026-09-07 from the photographs and the
 * Kingroon article numbers — B01889 is the saturated «Candy», HC258 the pastel «Rainbow Candy» —
 * so the third fix below gives FL-000162 the value «Rainbow Candy». Both then resolve to their
 * own dictionary entry (seed-colors.js), take distinct slugs, and the product rename (3k) no
 * longer stops on this product.
 *
 * Deliberately NOT fixed here, and why:
 *
 * - **Two `finish` values on one product** (Silk + Rainbow, Matte + Rainbow). Not a defect:
 *   `derive-material-taxonomy.js` writes multi-valued dimensions as several entries sharing a
 *   key, and the landings rely on it. What is broken is the admin form, which renders only the
 *   first entry per key — a frontend fix, not a data one.
 *
 * Idempotent: a second run reports "Nothing to do."
 *
 * Usage:
 *   node scripts/fillando_v_2/fix-known-data-defects.js --dry-run
 *   node scripts/fillando_v_2/fix-known-data-defects.js
 */

const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * One entry per known-broken document.
 *
 * `expect` is what makes this safe to hardcode: it is checked before anything is written, so a
 * fix cannot land on a document that has since changed. `apply` returns the `$set` payload, or
 * null when there is nothing left to do.
 */
const FIXES = [
	{
		id: 'petg-3kg-material',
		collection: 'products',
		_id: '6a81a21315e62e1899044300',
		what: 'Kingroon PETG (CoPET) 3 кг has an empty `material`, so the taxonomy derives nothing for it',
		why: 'It is the only product with no polymer, finish or series, which keeps it off every new filter and every landing.',
		expect: doc =>
			doc.name.includes('Kingroon PETG (CoPET)') && doc.name.includes('3 кг')
				? null
				: `name is ${JSON.stringify(doc.name)}, not the Kingroon PETG 3 кг product`,
		apply: doc => {
			const attributes = doc.attributes ?? []
			const current = attributes.find(a => a && a.k === 'material')
			if (current && String(current.v).trim() !== '') return null
			const next = current
				? attributes.map(a => (a.k === 'material' ? { ...a, v: 'PETG' } : a))
				: [...attributes, { k: 'material', l: 'Матеріал', v: 'PETG' }]
			return { set: { attributes: next }, describe: 'material "" → "PETG"' }
		}
	},
	{
		id: 'candy-hc258-colour',
		collection: 'product_variants',
		_id: '6a04457106200235a620061e',
		what: 'FL-000162 (Kingroon HC258) is stored as "Candy", the same colour as FL-000157 (B01889) on the same product',
		why:
			'One product cannot give two variants one colour: they would share a slug, the colour ' +
			'migration skips both and the product rename is refused. The photographs show two ' +
			'different filaments — B01889 a saturated rainbow, HC258 pastel candy shades.',
		expect: doc =>
			doc.sku === 'FL-000162' &&
			doc.vendor_product_sku === 'HC258' &&
			(doc.v_value === 'Candy' || doc.v_value === 'Rainbow Candy')
				? null
				: `expected FL-000162 / HC258 with v_value "Candy", found ${JSON.stringify({ sku: doc.sku, vendor_product_sku: doc.vendor_product_sku, v_value: doc.v_value })}`,
		apply: doc => {
			if (doc.v_value === 'Rainbow Candy') return null
			return {
				set: { v_value: 'Rainbow Candy' },
				describe: 'v_value "Candy" → "Rainbow Candy"'
			}
		}
	},
	// Two Kingroon variants whose Ukrainian value is a *different* colour's name in the
	// dictionary, so no synonym can tell them apart — only the Kingroon article number can. The
	// June 2026 invoice prints NPETG002 as «Sky Blue» (the shop wrote «Блакитний», which is Cyan)
	// and HCGS004 as «Cyan» (the shop wrote «Бірюзовий», which is Teal). The fix rewrites the
	// field that holds the original spelling: `v_value` before the colour step has run, and
	// `v_value_legacy` after it, since the colour step matches on the original and re-points.
	...[
		{
			id: 'npetg002-sky-blue',
			_id: '69c459b3cfa63d15569a1be0',
			sku: 'FL-000004',
			vendor: 'NPETG002-ZX',
			from: ['Блакитний', 'Cyan'],
			to: 'Sky Blue',
			what: 'FL-000004 (Kingroon NPETG002) is stored as «Блакитний», the dictionary name of Cyan; the invoice says Sky Blue'
		},
		{
			id: 'hc187-yellow-green',
			_id: '6a04291406200235a62005eb',
			sku: 'FL-000127',
			vendor: 'HC187',
			from: ['HC186', 'Dual Silk HC186'],
			to: 'Yellow-Green',
			what: "FL-000127 (Kingroon HC187) stores its neighbour's article code «HC186» as its colour; by the invoice order of the Dual-Silk pairs, confirmed from the photographs, it is Yellow-Green"
		},
		{
			id: 'hcgs004-cyan',
			_id: '69fb0c12c31a38c20471a8e3',
			sku: 'FL-000067',
			vendor: 'HCGS004',
			from: ['Бірюзовий', 'Teal'],
			to: 'Cyan',
			what: 'FL-000067 (Kingroon HCGS004) is stored as «Бірюзовий», the dictionary name of Teal; the invoice says Cyan'
		}
	].map(f => ({
		id: f.id,
		collection: 'product_variants',
		_id: f._id,
		what: f.what,
		why: "A shopper would read another colour's name on the spool; the supplier's own invoice names the colour.",
		expect: doc => {
			const stored = doc.v_value_legacy ?? doc.v_value
			return doc.sku === f.sku &&
				doc.vendor_product_sku === f.vendor &&
				[...f.from, f.to].includes(stored)
				? null
				: `expected ${f.sku} / ${f.vendor} with value ${JSON.stringify(f.from)}, found ${JSON.stringify({ sku: doc.sku, vendor_product_sku: doc.vendor_product_sku, v_value: doc.v_value, v_value_legacy: doc.v_value_legacy })}`
		},
		apply: doc => {
			const field = doc.v_value_legacy !== undefined ? 'v_value_legacy' : 'v_value'
			if (doc[field] === f.to) return null
			return {
				set: { [field]: f.to },
				describe: `${field} ${JSON.stringify(doc[field])} → ${JSON.stringify(f.to)}`
			}
		}
	})),
	{
		id: 'petg-3kg-category-type',
		collection: 'products',
		_id: '6a81a21315e62e1899044300',
		what: 'the same product stores `category_id` as a string instead of an ObjectId',
		why:
			'Any query matching products by category drops it. The storefront survives because the ' +
			'catalogue is built from variants, but an admin list filtered by category does not show it.',
		expect: doc =>
			typeof doc.category_id === 'string' ||
			doc.category_id instanceof mongoose.Types.ObjectId
				? null
				: `category_id is a ${typeof doc.category_id}, which is neither a string nor an ObjectId`,
		apply: doc => {
			if (typeof doc.category_id !== 'string') return null
			if (!mongoose.Types.ObjectId.isValid(doc.category_id)) {
				throw new Error(
					`category_id ${JSON.stringify(doc.category_id)} is not a valid ObjectId`
				)
			}
			return {
				set: { category_id: new mongoose.Types.ObjectId(doc.category_id) },
				describe: `category_id "${doc.category_id}" → ObjectId`
			}
		}
	}
]

/**
 * Reported, never written: a second pair of variants sharing one colour value on one product
 * would be the same shape of defect as the Candy pair was, and needs a person, not a rule.
 */
const NEEDS_A_DECISION = {
	what: 'two variants of one product share the same colour value',
	consequence:
		'They cannot both take the same dictionary colour (one product, one slug per colour), so ' +
		'both stay unmatched and out of the colour filter; the product rename refuses them.',
	resolution:
		'Look at the photographs, give one of them the colour it actually is (a fix here, or the ' +
		'admin), then re-run seed-colors.js and normalize-variant-colors.js.'
}

/** Pairs of variants on one product that still share a colour value, after the fixes above. */
async function checkSharedColourValues(db) {
	const rows = await db
		.collection('product_variants')
		.aggregate([
			{ $match: { v_value: { $type: 'string' } } },
			{
				$group: {
					_id: { product_id: '$product_id', v_value: '$v_value' },
					skus: { $push: '$sku' },
					n: { $sum: 1 }
				}
			},
			{ $match: { n: { $gt: 1 } } }
		])
		.toArray()
	// The fix for FL-000162 is applied a moment before this runs; on a dry run it has not been.
	return rows.filter(r => !(DRY_RUN && r._id.v_value === 'Candy'))
}

async function migrate(db) {
	const planned = []
	const skipped = []
	const problems = []

	for (const fix of FIXES) {
		const doc = await db
			.collection(fix.collection)
			.findOne({ _id: new mongoose.Types.ObjectId(fix._id) })

		if (!doc) {
			skipped.push({
				fix,
				reason: 'document not found — it may have been deleted or re-created'
			})
			continue
		}

		const mismatch = fix.expect(doc)
		if (mismatch) {
			problems.push({ fix, reason: mismatch })
			continue
		}

		let result
		try {
			result = fix.apply(doc)
		} catch (err) {
			problems.push({ fix, reason: err.message })
			continue
		}

		if (!result) {
			skipped.push({ fix, reason: 'already fixed' })
			continue
		}
		planned.push({ fix, doc, ...result })
	}

	console.log('Plan:')
	for (const p of planned) console.log(`  + ${p.fix.id}: ${p.describe}`)
	for (const s of skipped) console.log(`  = ${s.fix.id}: ${s.reason}`)
	for (const p of problems) console.log(`  ✗ ${p.fix.id}: ${p.reason}`)

	if (problems.length > 0) {
		console.error(
			'\nA fix no longer matches the document it was written for, so nothing was written.\n' +
				'The catalogue has changed since these defects were inspected: re-check them by hand\n' +
				'and update FIXES in this file.'
		)
		return false
	}

	if (planned.length === 0) {
		console.log('\nNothing to do.')
	} else if (DRY_RUN) {
		console.log(`\nWould apply ${planned.length} fix(es).`)
		console.log('Dry run complete — nothing was changed.')
	} else {
		let applied = 0
		for (const p of planned) {
			// Pinned on `_id` plus the field being replaced, so a concurrent admin save is skipped
			// rather than overwritten — there are no transactions on this standalone MongoDB.
			const field = Object.keys(p.set)[0]
			const res = await db
				.collection(p.fix.collection)
				.updateOne({ _id: p.doc._id, [field]: p.doc[field] }, { $set: p.set })
			if (res.matchedCount === 1) {
				applied += 1
				console.log(`  applied ${p.fix.id}`)
			} else {
				console.warn(
					`  ! ${p.fix.id} changed while this ran — skipped, re-run to pick it up`
				)
			}
		}
		console.log(`\nApplied ${applied} of ${planned.length} fix(es).`)
	}

	// ---------- what a person still has to settle ----------
	const shared = await checkSharedColourValues(db)
	if (shared.length > 0) {
		console.log('\nNeeds a decision, not a script:')
		console.log(`  • ${NEEDS_A_DECISION.what}`)
		for (const r of shared) console.log(`      ${r.skus.join(' + ')} — "${r._id.v_value}"`)
		console.log(`    ${NEEDS_A_DECISION.consequence}`)
		console.log(`    ${NEEDS_A_DECISION.resolution}`)
	}

	// ---------- verify ----------
	// Skipped on a dry run: nothing was written, so reporting the unfixed state as a failure
	// would read as an error rather than as the reason the fix exists.
	const product = DRY_RUN
		? null
		: await db
				.collection('products')
				.findOne({ _id: new mongoose.Types.ObjectId('6a81a21315e62e1899044300') })
	if (product) {
		const material = (product.attributes ?? []).find(a => a && a.k === 'material')
		const materialOk = material && String(material.v).trim() !== ''
		const typeOk = typeof product.category_id !== 'string'
		console.log('\nVerify:')
		console.log(
			`  ${materialOk ? 'OK ' : 'FAIL'} Kingroon PETG 3 кг has a material: ${material ? JSON.stringify(material.v) : 'missing'}`
		)
		console.log(`  ${typeOk ? 'OK ' : 'FAIL'} its category_id is an ObjectId`)
		if (!materialOk || !typeOk) return false
	}

	return true
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

module.exports = { FIXES, NEEDS_A_DECISION }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
