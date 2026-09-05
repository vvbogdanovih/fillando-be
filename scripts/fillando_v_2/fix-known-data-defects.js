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
 * Deliberately NOT fixed here, and why:
 *
 * - **Two variants of one product both called "Candy"** (FL-000157 at ₴890 / stock 50 /
 *   prom_id 2693625316, FL-000162 at ₴860 / stock 60 / prom_id 2693886972, on Kingroon PLA Silk
 *   Rainbow). They are two live Prom listings that arrived with the same colour name, so which
 *   one is which is a question about the photographs, not about the data. Guessing would put a
 *   wrong colour on a real product. Reported at the end for the owner to settle; until then both
 *   stay out of the colour dictionary, which costs nothing else.
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
		id: 'petg-3kg-category-type',
		collection: 'products',
		_id: '6a81a21315e62e1899044300',
		what: 'the same product stores `category_id` as a string instead of an ObjectId',
		why:
			'Any query matching products by category drops it. The storefront survives because the ' +
			'catalogue is built from variants, but an admin list filtered by category does not show it.',
		expect: doc =>
			typeof doc.category_id === 'string' || doc.category_id instanceof mongoose.Types.ObjectId
				? null
				: `category_id is a ${typeof doc.category_id}, which is neither a string nor an ObjectId`,
		apply: doc => {
			if (typeof doc.category_id !== 'string') return null
			if (!mongoose.Types.ObjectId.isValid(doc.category_id)) {
				throw new Error(`category_id ${JSON.stringify(doc.category_id)} is not a valid ObjectId`)
			}
			return {
				set: { category_id: new mongoose.Types.ObjectId(doc.category_id) },
				describe: `category_id "${doc.category_id}" → ObjectId`
			}
		}
	}
]

/** Reported, never written: needs a person who can look at the product photographs. */
const NEEDS_A_DECISION = [
	{
		what: 'two variants of Kingroon PLA Silk Rainbow are both called "Candy"',
		skus: ['FL-000157', 'FL-000162'],
		consequence:
			'They cannot both take the same dictionary colour (one product, one slug per colour), so ' +
			'both stay unmatched and out of the colour filter. Renaming the product is refused with a ' +
			'409 while they collide.',
		resolution:
			'Open both in the admin, give the second one the colour it actually is, or archive it if ' +
			'it is a duplicate Prom listing. Then re-run seed-colors.js and normalize-variant-colors.js.'
	}
]

async function checkCandy(db) {
	const found = await db
		.collection('product_variants')
		.find({ v_value: 'Candy' })
		.project({ sku: 1, price: 1, stock: 1 })
		.toArray()
	return found
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
			skipped.push({ fix, reason: 'document not found — it may have been deleted or re-created' })
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
				console.warn(`  ! ${p.fix.id} changed while this ran — skipped, re-run to pick it up`)
			}
		}
		console.log(`\nApplied ${applied} of ${planned.length} fix(es).`)
	}

	// ---------- what a person still has to settle ----------
	const candy = await checkCandy(db)
	if (candy.length > 1) {
		console.log('\nNeeds a decision, not a script:')
		for (const item of NEEDS_A_DECISION) {
			console.log(`  • ${item.what}`)
			for (const v of candy) console.log(`      ${v.sku} — ₴${v.price}, stock ${v.stock}`)
			console.log(`    ${item.consequence}`)
			console.log(`    ${item.resolution}`)
		}
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
		console.log(`  ${materialOk ? 'OK ' : 'FAIL'} Kingroon PETG 3 кг has a material: ${material ? JSON.stringify(material.v) : 'missing'}`)
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
