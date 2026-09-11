/**
 * Read-only report on the catalogue's state: what the shopper would actually get.
 *
 * The migrations each verify their own work, but each only sees its own step. This answers the
 * question the operator has after the chain finishes, or before it starts: are the filters
 * populated, do the landings list anything, is every refill on its own product, and how much of
 * the colour axis reached the dictionary. It writes nothing, so it is safe to point at
 * production.
 *
 * Usage:
 *   node scripts/fillando_v_2/verify-catalog-state.js
 *   DATABASE_URL=mongodb://127.0.0.1:27018/rehearsal node scripts/fillando_v_2/verify-catalog-state.js
 */

const mongoose = require('mongoose')

const { CATEGORY_SLUG, LANDINGS, filterConditions } = require('./seed-landings.js')
const { isRefillVariant, isColorAxis } = require('./normalize-variant-colors.js')

const DIMENSIONS = ['polymer', 'finish', 'reinforcement', 'series', 'spool_included']
const hasText = value =>
	typeof value === 'string' &&
	value
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;|&#160;/gi, ' ')
		.trim().length > 0

function pct(n, total) {
	return total === 0 ? '—' : `${Math.round((100 * n) / total)}%`
}

async function landingCounts(db, category) {
	const landings = await db
		.collection('landings')
		.find({ category_id: category._id })
		.sort({ order: 1 })
		.toArray()
	const rows = []
	for (const landing of landings) {
		const conditions = filterConditions(landing.filters ?? {})
		let matches = 0
		if (conditions.length > 0) {
			const [row] = await db
				.collection('product_variants')
				.aggregate([
					{ $match: { category_id: category._id, status: 'active' } },
					{
						$lookup: {
							from: 'products',
							localField: 'product_id',
							foreignField: '_id',
							as: 'product'
						}
					},
					{ $unwind: '$product' },
					{ $match: { $and: conditions } },
					{ $count: 'n' }
				])
				.toArray()
			matches = row?.n ?? 0
		}
		rows.push({
			slug: landing.slug,
			status: landing.status,
			matches,
			hasCopy: [
				landing.h1,
				landing.title,
				landing.meta_description,
				landing.intro_html,
				landing.bottom_html
			].every(hasText),
			faq: (landing.faq ?? []).filter(item => hasText(item.q) && hasText(item.a)).length
		})
	}
	return rows
}

async function report(db, { complete = false } = {}) {
	const category = await db.collection('categories').findOne({ slug: CATEGORY_SLUG })
	if (!category) {
		console.error(`FAIL: No "${CATEGORY_SLUG}" category — check the restored database.`)
		return false
	}

	// Compared as a string on purpose: at least one product in production stores `category_id`
	// as a string rather than an ObjectId, and a plain equality match silently drops it — which
	// then looks like an orphaned variant rather than the type mismatch it is.
	const products = await db
		.collection('products')
		.find({ $expr: { $eq: [{ $toString: '$category_id' }, String(category._id)] } })
		.toArray()
	const variants = await db
		.collection('product_variants')
		.find({ category_id: category._id })
		.toArray()
	const active = variants.filter(v => v.status === 'active')

	console.log(
		`Category "${category.name}": ${products.length} products, ${variants.length} variants (${active.length} active).`
	)

	// ---- filters the sidebar will offer ----
	const required = (category.required_attributes ?? []).map(a => a.key)
	const offered = DIMENSIONS.filter(d => required.includes(d))
	const missing = DIMENSIONS.filter(d => !required.includes(d))
	console.log(
		`\nCatalogue filters: ${offered.length ? offered.join(', ') : 'none of the new ones'}`
	)
	if (required.includes('material')) console.log('  ⚠ still offering the old "material" filter')
	if (missing.length) console.log(`  not offered yet: ${missing.join(', ')}`)

	// ---- how many products carry each dimension ----
	console.log('\nProducts carrying each dimension:')
	for (const key of DIMENSIONS) {
		const values = new Map()
		let carried = 0
		for (const p of products) {
			const own = (p.attributes ?? []).filter(a => a && a.k === key)
			if (own.length === 0) continue
			carried += 1
			for (const a of own) values.set(String(a.v), (values.get(String(a.v)) ?? 0) + 1)
		}
		const spread = [...values.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([v, n]) => `${v}:${n}`)
			.join(', ')
		const flag = carried > 0 && values.size === 1 ? '  ⚠ single value, filters nothing' : ''
		console.log(
			`  ${key.padEnd(15)} ${String(carried).padStart(3)}/${products.length} ${pct(carried, products.length).padStart(4)}  ${spread}${flag}`
		)
	}

	const noMaterial = products.filter(p => {
		const m = (p.attributes ?? []).find(a => a && a.k === 'material')
		return !m || String(m.v).trim() === ''
	})
	if (noMaterial.length) {
		console.log(
			`\n⚠ ${noMaterial.length} product(s) with no usable "material" — skipped by the taxonomy:`
		)
		for (const p of noMaterial) console.log(`    ${p.name}`)
	}

	// ---- refills ----
	const refills = variants.filter(isRefillVariant)
	const mixed = new Map()
	for (const r of refills) {
		const siblings = variants.filter(v => String(v.product_id) === String(r.product_id))
		if (siblings.some(v => !isRefillVariant(v))) mixed.set(String(r.product_id), r)
	}
	console.log(
		`\nRefills: ${refills.length} variant(s) still carrying the marker, ${mixed.size} of them beside spooled variants.`
	)
	if (mixed.size > 0) {
		console.log('  ⚠ split-refill-products.js has not run, or new mixed products appeared:')
		for (const [id, r] of mixed) {
			const p = products.find(x => String(x._id) === id)
			console.log(`    ${r.sku} on "${p ? p.name : id}"`)
		}
	}

	// ---- colour axis ----
	const onColorAxis = active.filter(v => {
		const p = products.find(x => String(x._id) === String(v.product_id))
		return isColorAxis(p?.variant_type)
	})
	const withColor = onColorAxis.filter(v => v.color_id)
	console.log(
		`\nColour: ${withColor.length}/${onColorAxis.length} active variants on a colour axis point at the dictionary (${pct(withColor.length, onColorAxis.length)}).`
	)
	const dictionary = await db.collection('colors').countDocuments({})
	console.log(`  dictionary holds ${dictionary} colour(s)`)
	const drift = onColorAxis.filter(v => v.color_id && !v.color_family).length
	if (drift) console.log(`  ⚠ ${drift} variant(s) have color_id but no color_family`)
	const zeroCoverage = products
		.map(p => {
			const own = onColorAxis.filter(v => String(v.product_id) === String(p._id))
			return { name: p.name, total: own.length, matched: own.filter(v => v.color_id).length }
		})
		.filter(r => r.total > 0 && r.matched === 0)
	if (zeroCoverage.length) {
		console.log(`  ⚠ ${zeroCoverage.length} product(s) with no colour matched at all:`)
		for (const r of zeroCoverage) console.log(`    ${r.total} variant(s) — ${r.name}`)
	}

	// ---- landings ----
	const rows = await landingCounts(db, category)
	if (rows.length === 0) {
		console.log('\nLandings: none seeded yet.')
	} else {
		const publishable = rows.filter(r => r.matches > 0 && r.hasCopy)
		console.log(
			`\nLandings: ${rows.length} total, ${rows.filter(r => r.hasCopy).length} with copy, ${rows.filter(r => r.status === 'active').length} published, ${publishable.length} ready to publish.`
		)
		for (const r of rows) {
			const flag = r.matches === 0 ? ' ⚠ matches nothing, must stay draft' : ''
			console.log(
				`  /${CATEGORY_SLUG}/${r.slug.padEnd(10)} ${String(r.matches).padStart(4)} variant(s)  ` +
					`${r.status.padEnd(6)} ${r.hasCopy ? `copy, FAQ ${r.faq}` : 'NO COPY'}${flag}`
			)
		}
		const publishedEmpty = rows.filter(r => r.status === 'active' && r.matches === 0)
		if (publishedEmpty.length) {
			console.log(
				`\n  ⚠ PUBLISHED AND EMPTY: ${publishedEmpty.map(r => r.slug).join(', ')} — unpublish these.`
			)
		}
	}

	// ---- integrity ----
	console.log('\nIntegrity:')
	const orphans = variants.filter(
		v => !products.some(p => String(p._id) === String(v.product_id))
	)
	const slugs = new Map()
	const dupSlugs = []
	for (const v of variants) {
		if (slugs.has(v.slug)) dupSlugs.push(v.slug)
		slugs.set(v.slug, v.sku)
	}
	const stringCategoryId = products.filter(p => typeof p.category_id === 'string')
	const noVariants = products.filter(
		p => !variants.some(v => String(v.product_id) === String(p._id))
	)
	// Step 3k. A WARN, not a FAIL: the rehearsal runs this report before the chain as well.
	const longNames = products.filter(
		p => typeof p.name === 'string' && p.name.startsWith('Філамент (пластик для 3D принтера) ')
	)
	const parked = variants.filter(v => typeof v.slug === 'string' && v.slug.includes('-moving-'))
	console.log(
		`  ${orphans.length === 0 ? 'OK  ' : 'FAIL'} variants pointing at a missing product: ${orphans.length}`
	)
	console.log(
		`  ${dupSlugs.length === 0 ? 'OK  ' : 'FAIL'} duplicate variant slugs: ${dupSlugs.length}`
	)
	console.log(
		`  ${parked.length === 0 ? 'OK  ' : 'FAIL'} variant slugs parked on -moving- (a rename that did not finish): ${parked.length}`
	)
	console.log(
		`  ${longNames.length === 0 ? 'OK  ' : 'WARN'} products still carrying the long SEO prefix (step 3k not run): ${longNames.length}`
	)
	console.log(
		`  ${stringCategoryId.length === 0 ? 'OK  ' : 'WARN'} products whose category_id is a string, not an ObjectId: ${stringCategoryId.length}`
	)
	for (const p of stringCategoryId) {
		console.log(`      ${p.name}`)
		console.log(
			'      any query matching products by category_id drops it; re-saving it in the admin fixes the type'
		)
	}
	console.log(
		`  ${noVariants.length === 0 ? 'OK  ' : 'WARN'} products with no variants: ${noVariants.length}`
	)
	for (const p of noVariants) console.log(`      ${p.name}`)

	let ok =
		products.length > 0 &&
		variants.length > 0 &&
		orphans.length === 0 &&
		dupSlugs.length === 0 &&
		parked.length === 0
	if (!products.length || !variants.length)
		console.error('FAIL: restored catalogue is empty or incomplete')
	if (complete) {
		const colors = await db.collection('colors').find({}).toArray()
		const colorById = new Map(colors.map(c => [String(c._id), c]))
		const allProducts = await db.collection('products').find({}).toArray()
		const allVariants = await db.collection('product_variants').find({}).toArray()
		const categories = await db.collection('categories').find({}).toArray()
		const categoryIds = new Set(categories.map(c => String(c._id)))
		const productById = new Map(allProducts.map(p => [String(p._id), p]))
		const allSlugs = allVariants.map(v => v.slug)
		const badColors = onColorAxis.filter(v => {
			const color = colorById.get(String(v.color_id))
			return !color || color.family !== v.color_family || color.name_en !== v.v_value
		})
		const checks = {
			'products referencing absent categories': allProducts.filter(
				p => !categoryIds.has(String(p.category_id))
			).length,
			'variants with absent product/category or mismatched category': allVariants.filter(
				v => {
					const product = productById.get(String(v.product_id))
					return (
						!product ||
						!categoryIds.has(String(v.category_id)) ||
						String(product.category_id) !== String(v.category_id)
					)
				}
			).length,
			'global duplicate variant slugs': allSlugs.length - new Set(allSlugs).size,
			'variants without a usable slug': allVariants.filter(
				v => typeof v.slug !== 'string' || !v.slug.trim() || v.slug.includes('-moving-')
			).length,
			'missing filter dimensions': missing.length,
			'legacy material filter still offered': Number(required.includes('material')),
			'products without material': noMaterial.length,
			'products without derived polymer': products.filter(
				p => !(p.attributes ?? []).some(a => a?.k === 'polymer' && a.v)
			).length,
			'products without spool flag': products.filter(
				p => !(p.attributes ?? []).some(a => a?.k === 'spool_included' && a.v)
			).length,
			'mixed refill products': mixed.size,
			'missing or inconsistent colour assignments': badColors.length,
			'active variants without positive integer shipping weight': active.filter(
				v => !Number.isInteger(v.weight_g) || v.weight_g <= 0
			).length,
			'missing seeded landings': LANDINGS.filter(l => !rows.some(r => r.slug === l.slug))
				.length,
			'seeded landings without copy or FAQ': rows.filter(
				r => LANDINGS.some(l => l.slug === r.slug) && (!r.hasCopy || !r.faq)
			).length,
			'published empty landings': rows.filter(r => r.status === 'active' && !r.matches)
				.length,
			'long product names': longNames.length,
			'string category references': stringCategoryId.length
		}
		console.log('\nComplete migration checks (draft landings are allowed):')
		for (const [label, count] of Object.entries(checks)) {
			console.log(`  ${count ? 'FAIL' : 'OK  '} ${label}: ${count}`)
			if (count) ok = false
		}
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
		console.log(`Database "${db.databaseName}" on ${mongoose.connection.host}.\n`)
		ok = await report(db, { complete: process.argv.includes('--complete') })
	} finally {
		await mongoose.disconnect()
	}
	if (!ok) process.exit(1)
}

module.exports = { report, landingCounts }
if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
