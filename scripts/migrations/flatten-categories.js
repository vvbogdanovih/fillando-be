/**
 * Migration: flatten the two-level category structure.
 *
 * Promotes every embedded subcategory to a top-level category (keeping its _id,
 * so product/variant references stay valid), renames subcategory_id -> category_id
 * on products and product_variants, deletes the old parent categories and
 * rebuilds the affected indexes.
 *
 * Idempotent: re-running after a successful migration is a no-op.
 *
 * Usage:
 *   node scripts/migrations/flatten-categories.js --dry-run   # print the plan, change nothing
 *   node scripts/migrations/flatten-categories.js             # apply
 *   node scripts/migrations/flatten-categories.js --force     # apply even with orphan products
 */

const mongoose = require('mongoose')
require('dotenv').config()

const DRY_RUN = process.argv.includes('--dry-run')
const FORCE = process.argv.includes('--force')

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}

async function main() {
	await mongoose.connect(DATABASE_URL)
	console.log(`Connected to MongoDB.${DRY_RUN ? ' (dry run)' : ''}`)

	const db = mongoose.connection.db
	const categories = db.collection('categories')
	const products = db.collection('products')
	const variants = db.collection('product_variants')

	// ---------- 1. Load + plan ----------
	const allCategories = await categories.find({}).toArray()
	const parents = allCategories.filter(c => (c.subcategories ?? []).length > 0)
	const flat = allCategories.filter(c => (c.subcategories ?? []).length === 0)

	const promotions = []
	for (const parent of parents) {
		parent.subcategories.forEach((sub, index) => {
			promotions.push({
				parent,
				doc: {
					_id: sub._id,
					name: sub.name,
					slug: sub.slug,
					// Copy verbatim: product attributes.k and live filter query params
					// were generated from these keys — never regenerate them here.
					required_attributes: sub.required_attributes ?? [],
					image: parent.image ?? null,
					order: (parent.order ?? 0) * 10 + index,
					createdAt: parent.createdAt ?? new Date(),
					updatedAt: new Date()
				}
			})
		})
	}

	console.log(`Categories: ${allCategories.length} total, ${parents.length} parents to delete, ` +
		`${flat.length} already flat, ${promotions.length} subcategories to promote.`)
	for (const p of promotions) {
		console.log(`  promote "${p.doc.name}" (${p.doc.slug}, _id=${p.doc._id}) from parent "${p.parent.name}"`)
	}

	// ---------- Preflight checks ----------
	const problems = []

	// Unique indexes exist on BOTH name and slug — check collisions against
	// surviving flat categories and among the promoted docs themselves.
	const seenSlugs = new Map(flat.map(c => [c.slug, c.name]))
	const seenNames = new Set(flat.map(c => c.name))
	for (const p of promotions) {
		if (seenSlugs.has(p.doc.slug)) problems.push(`slug collision: "${p.doc.slug}"`)
		if (seenNames.has(p.doc.name)) problems.push(`name collision: "${p.doc.name}"`)
		seenSlugs.set(p.doc.slug, p.doc.name)
		seenNames.add(p.doc.name)
	}

	const knownSubIds = new Set(promotions.map(p => String(p.doc._id)))
	// Categories already promoted by a previous run also count as valid targets.
	for (const c of flat) knownSubIds.add(String(c._id))

	const orphanProducts = await products
		.find({ subcategory_id: { $exists: true } })
		.project({ _id: 1, name: 1, subcategory_id: 1 })
		.toArray()
	const realOrphans = orphanProducts.filter(p => !knownSubIds.has(String(p.subcategory_id)))
	if (realOrphans.length > 0) {
		for (const p of realOrphans) {
			problems.push(`orphan product ${p._id} ("${p.name}"): subcategory_id ${p.subcategory_id} resolves to nothing`)
		}
	}

	// Variants whose denormalized subcategory_id disagrees with their product's.
	// Compare as strings: legacy data mixes ObjectId and string for the same id.
	const desynced = await variants
		.aggregate([
			{ $match: { subcategory_id: { $exists: true } } },
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product'
				}
			},
			{ $unwind: '$product' },
			{
				$match: {
					$expr: {
						$ne: [
							{ $toString: '$subcategory_id' },
							{ $toString: '$product.subcategory_id' }
						]
					}
				}
			},
			{ $project: { _id: 1, slug: 1, subcategory_id: 1, product_subcategory_id: '$product.subcategory_id' } }
		])
		.toArray()
	if (desynced.length > 0) {
		console.log(`Desynced variants (will be fixed from their product): ${desynced.length}`)
		for (const v of desynced) console.log(`  ${v._id} (${v.slug})`)
	}

	if (problems.length > 0) {
		console.error('\nPreflight problems:')
		for (const msg of problems) console.error(`  - ${msg}`)
		const onlyOrphans = problems.every(msg => msg.startsWith('orphan product'))
		if (!(FORCE && onlyOrphans)) {
			console.error(FORCE
				? 'Collisions cannot be forced. Aborting.'
				: 'Aborting. (Orphan-only problems can be skipped with --force.)')
			await mongoose.disconnect()
			process.exit(1)
		}
		console.log('--force: orphan products will be left untouched.')
	}

	const productsToRename = orphanProducts.length - (FORCE ? realOrphans.length : 0)
	const variantsToRename = await variants.countDocuments({ subcategory_id: { $exists: true } })

	console.log(`\nPlan: fix ${desynced.length} desynced variants, rename subcategory_id on ` +
		`~${productsToRename} products and ${variantsToRename} variants, delete ${parents.length} parent categories.`)

	if (DRY_RUN) {
		const sample = orphanProducts.find(p => knownSubIds.has(String(p.subcategory_id)))
		if (sample) {
			console.log('\nSample product before:', JSON.stringify(await products.findOne({ _id: sample._id })))
			console.log(`After: category_id becomes ${sample.subcategory_id}, subcategory_id removed.`)
		}
		console.log('\nDry run complete — nothing was changed.')
		await mongoose.disconnect()
		return
	}

	// ---------- 3. Execute ----------
	// a. Promote subcategories (upsert => re-runnable).
	for (const p of promotions) {
		await categories.replaceOne({ _id: p.doc._id }, p.doc, { upsert: true })
	}
	console.log(`Promoted ${promotions.length} subcategories.`)

	// b. Fix desynced variants first — trust the product.
	for (const v of desynced) {
		await variants.updateOne(
			{ _id: v._id },
			{
				$set: {
					subcategory_id: new mongoose.Types.ObjectId(String(v.product_subcategory_id))
				}
			}
		)
	}
	if (desynced.length > 0) console.log(`Fixed ${desynced.length} desynced variants.`)

	// c/d. Move subcategory_id → category_id, intentionally overwriting the old
	// parent-pointing category_id on products. Pipeline update with $toObjectId
	// also normalizes legacy string ids to ObjectId.
	const orphanIds = FORCE ? realOrphans.map(p => p._id) : []
	const prodRes = await products.updateMany(
		{ subcategory_id: { $exists: true }, _id: { $nin: orphanIds } },
		[
			{ $set: { category_id: { $toObjectId: '$subcategory_id' } } },
			{ $unset: 'subcategory_id' }
		]
	)
	console.log(`Products renamed: ${prodRes.modifiedCount}.`)

	const varRes = await variants.updateMany({ subcategory_id: { $exists: true } }, [
		{ $set: { category_id: { $toObjectId: '$subcategory_id' } } },
		{ $unset: 'subcategory_id' }
	])
	console.log(`Variants renamed: ${varRes.modifiedCount}.`)

	// e. Delete parents; strip any leftover subcategories arrays.
	if (parents.length > 0) {
		const delRes = await categories.deleteMany({ _id: { $in: parents.map(p => p._id) } })
		console.log(`Deleted ${delRes.deletedCount} parent categories.`)
	}
	await categories.updateMany({}, { $unset: { subcategories: '' } })

	// f. Indexes.
	await variants.createIndex({ category_id: 1, status: 1 })
	for (const [coll, index] of [
		[variants, 'subcategory_id_1_status_1'],
		[categories, 'subcategories._id_1']
	]) {
		try {
			await coll.dropIndex(index)
			console.log(`Dropped index ${index}.`)
		} catch (err) {
			if (err.codeName === 'IndexNotFound') console.log(`Index ${index} already gone.`)
			else throw err
		}
	}

	// g. Verify.
	const checks = {
		'products with subcategory_id': await products.countDocuments({
			subcategory_id: { $exists: true },
			_id: { $nin: orphanIds }
		}),
		'variants with subcategory_id': await variants.countDocuments({ subcategory_id: { $exists: true } }),
		'categories with subcategories': await categories.countDocuments({ subcategories: { $exists: true } })
	}

	const validCategoryIds = new Set(
		(await categories.find({}).project({ _id: 1 }).toArray()).map(c => String(c._id))
	)
	const allProducts = await products.find({}).project({ category_id: 1 }).toArray()
	checks['products with dangling category_id'] = allProducts.filter(
		p => !validCategoryIds.has(String(p.category_id))
	).length

	checks['variants desynced from product'] = (
		await variants
			.aggregate([
				{
					$lookup: {
						from: 'products',
						localField: 'product_id',
						foreignField: '_id',
						as: 'product'
					}
				},
				{ $unwind: '$product' },
				{
					$match: {
						$expr: {
							$ne: [
								{ $toString: '$category_id' },
								{ $toString: '$product.category_id' }
							]
						}
					}
				},
				{ $count: 'n' }
			])
			.toArray()
	)[0]?.n ?? 0

	console.log('\nVerify:')
	let failed = false
	for (const [label, count] of Object.entries(checks)) {
		const ok = count === 0
		if (!ok) failed = true
		console.log(`  ${ok ? 'OK ' : 'FAIL'} ${label}: ${count}`)
	}
	const finalCount = await categories.countDocuments()
	console.log(`  categories now: ${finalCount} (expected ${flat.length + promotions.length})`)
	if (finalCount !== flat.length + promotions.length) failed = true

	await mongoose.disconnect()
	if (failed) {
		console.error('\nVerification FAILED — inspect the database before deploying.')
		process.exit(1)
	}
	console.log('\nDone.')
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
