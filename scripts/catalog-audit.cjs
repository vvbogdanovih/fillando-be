#!/usr/bin/env node
// Read-only preflight for TD-0013. No dotenv, production URL, write or migration mode.
const fs = require('node:fs')

const id = value => (value == null ? null : String(value.$oid ?? value))
const reserved = new Set([
	'category_id',
	'page',
	'limit',
	'sort',
	'price_min',
	'price_max',
	'color_family'
])

function auditCatalog(input) {
	const names = ['categories', 'products', 'product_variants', 'landings', 'colors']
	for (const name of names) {
		if (!Array.isArray(input?.[name])) throw new Error(`Missing collection array: ${name}`)
		if (input[name].some(row => !row || typeof row !== 'object' || !id(row._id))) {
			throw new Error(`Invalid document in ${name}`)
		}
	}
	const issues = []
	const issue = (code, collection, row, detail) =>
		issues.push({ code, collection, id: id(row._id), detail })
	if (!input.categories.length || !input.products.length || !input.product_variants.length) {
		issues.push({
			code: 'incomplete_inventory',
			collection: 'catalog',
			id: null,
			detail: 'No category, product or variant data; cannot establish migration readiness'
		})
	}
	const maps = Object.fromEntries(
		names.map(name => [name, new Map(input[name].map(row => [id(row._id), row]))])
	)
	function duplicates(collection, key, valueOf = row => row[key]) {
		const seen = new Map()
		for (const row of input[collection]) {
			const value = valueOf(row)
			if (value == null || value === '') {
				issue('missing_identity', collection, row, key)
				continue
			}
			if (seen.has(value))
				issue('duplicate_identity', collection, row, `${key}; first=${seen.get(value)}`)
			seen.set(value, id(row._id))
		}
	}
	for (const name of names) duplicates(name, '_id', row => id(row._id))
	duplicates('categories', 'slug')
	duplicates('product_variants', 'slug')
	duplicates('product_variants', 'sku')
	duplicates('landings', 'category_id/slug', row =>
		row.slug ? `${id(row.category_id)}/${row.slug}` : null
	)

	for (const c of input.categories) {
		const attrs = c.required_attributes
		if (!Array.isArray(attrs)) {
			issue('invalid_attributes', 'categories', c, 'required_attributes is not an array')
			continue
		}
		const keys = new Set()
		for (const a of attrs) {
			if (!a || typeof a.key !== 'string' || !a.key) {
				issue('missing_attribute_key', 'categories', c, 'definition has no key')
				continue
			}
			if (keys.has(a.key)) issue('duplicate_attribute_key', 'categories', c, a.key)
			keys.add(a.key)
			if (reserved.has(a.key)) issue('reserved_attribute_key', 'categories', c, a.key)
			if (typeof a.is_required !== 'boolean')
				issue('missing_requiredness', 'categories', c, a.key)
			if (!['range', 'multi-select'].includes(a.filter_type))
				issue('invalid_filter_type', 'categories', c, a.key)
		}
		if (['catalog', 'products', 'search', 'admin', 'auth', 'checkout'].includes(c.slug)) {
			issue('legacy_route_collision', 'categories', c, c.slug)
		}
		const visited = new Set([id(c._id)])
		let parent = id(c.parent_id)
		while (parent) {
			if (visited.has(parent)) {
				issue('category_cycle', 'categories', c, parent)
				break
			}
			visited.add(parent)
			const ancestor = maps.categories.get(parent)
			if (!ancestor) {
				issue('orphan_parent', 'categories', c, parent)
				break
			}
			parent = id(ancestor.parent_id)
		}
	}
	for (const p of input.products) {
		const c = maps.categories.get(id(p.category_id))
		if (!c) issue('orphan_category', 'products', p, id(p.category_id))
		if (!Array.isArray(p.attributes)) {
			issue('invalid_attributes', 'products', p, 'attributes is not an array')
			continue
		}
		const definitions = new Map(
			(c?.required_attributes ?? []).filter(Boolean).map(a => [a.key, a])
		)
		for (const a of p.attributes) {
			if (!a || !a.k) {
				issue('missing_attribute_key', 'products', p, 'entry has no key')
				continue
			}
			// Repeated keys are valid legacy multi-values, not duplicate definitions.
			if (!definitions.has(a.k)) issue('unregistered_attribute', 'products', p, a.k)
			if (typeof a.v === 'string' && a.v.includes(','))
				issue('comma_in_value', 'products', p, a.k)
			if (
				definitions.get(a.k)?.filter_type === 'range' &&
				a.v !== '' &&
				a.v != null &&
				(typeof a.v === 'boolean' || !Number.isFinite(Number(a.v)))
			) {
				issue('non_numeric_range', 'products', p, a.k)
			}
		}
		if (p.variant_type?.key && !p.attributes.some(a => a?.k === p.variant_type.key)) {
			issue('axis_missing_from_product', 'products', p, p.variant_type.key)
		}
	}
	for (const v of input.product_variants) {
		const p = maps.products.get(id(v.product_id))
		if (!p) issue('orphan_product', 'product_variants', v, id(v.product_id))
		else if (id(p.category_id) !== id(v.category_id))
			issue('category_drift', 'product_variants', v, id(v.category_id))
		if (v.color_id && !maps.colors.has(id(v.color_id)))
			issue('orphan_color', 'product_variants', v, id(v.color_id))
	}
	for (const l of input.landings) {
		const c = maps.categories.get(id(l.category_id))
		if (!c) issue('orphan_category', 'landings', l, id(l.category_id))
		const keys = new Set((c?.required_attributes ?? []).filter(Boolean).map(a => a.key))
		keys.add('color_family')
		for (const [key, values] of Object.entries(l.filters ?? {})) {
			if (!keys.has(key)) issue('unknown_landing_key', 'landings', l, key)
			if (!Array.isArray(values)) issue('invalid_landing_values', 'landings', l, key)
		}
	}
	const routes = []
	for (const c of input.categories)
		if (c.slug)
			routes.push({
				kind: 'category',
				id: id(c._id),
				from: `/${c.slug}`,
				to: `/catalog/${c.slug}`
			})
	for (const l of input.landings) {
		const c = maps.categories.get(id(l.category_id))
		if (c?.slug && l.slug)
			routes.push({
				kind: 'landing',
				id: id(l._id),
				from: `/${c.slug}/${l.slug}`,
				to: `/catalog/${c.slug}/${l.slug}`,
				status: l.status
			})
	}
	for (const v of input.product_variants)
		if (v.slug)
			routes.push({
				kind: 'variant',
				id: id(v._id),
				from: `/products/${v.slug}`,
				to: `/products/${v.slug}`,
				status: v.status
			})
	return {
		schema_version: 1,
		counts: Object.fromEntries(names.map(name => [name, input[name].length])),
		issue_counts: issues.reduce((counts, row) => {
			counts[row.code] = (counts[row.code] ?? 0) + 1
			return counts
		}, {}),
		issues,
		// Candidates only: excludes external URLs/query URLs and does not authorize redirects.
		route_candidates: routes
	}
}

async function main(args) {
	let input
	if (args.length === 1 && args[0] === '--local') {
		const { MongoClient } = require('mongodb')
		const client = new MongoClient('mongodb://127.0.0.1:27019/fillando', {
			serverSelectionTimeoutMS: 3000
		})
		try {
			await client.connect()
			const db = client.db('fillando')
			const fields = {
				categories: { slug: 1, required_attributes: 1, parent_id: 1 },
				products: { category_id: 1, attributes: 1, variant_type: 1 },
				product_variants: {
					product_id: 1,
					category_id: 1,
					color_id: 1,
					slug: 1,
					sku: 1,
					status: 1
				},
				landings: { category_id: 1, slug: 1, filters: 1, status: 1 },
				colors: { _id: 1 }
			}
			input = {}
			for (const [name, projection] of Object.entries(fields))
				input[name] = await db.collection(name).find({}, { projection }).toArray()
		} finally {
			await client.close()
		}
	} else if (args.length === 2 && args[0] === '--input') {
		input = JSON.parse(fs.readFileSync(args[1], 'utf8'))
	} else {
		throw new Error('Usage: node scripts/catalog-audit.cjs --local | --input snapshot.json')
	}
	const result = auditCatalog(input)
	process.stdout.write(
		JSON.stringify(
			{
				...result,
				source: args[0] === '--local' ? 'local:27019/fillando' : 'offline_snapshot'
			},
			null,
			2
		) + '\n'
	)
	if (result.issues.length) process.exitCode = 2
}

module.exports = { auditCatalog }
if (require.main === module)
	main(process.argv.slice(2)).catch(error => {
		process.stderr.write(`Catalog audit failed: ${error.message}\n`)
		process.exitCode = 1
	})
