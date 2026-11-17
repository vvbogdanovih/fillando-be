const { test } = require('node:test')
const assert = require('node:assert/strict')
const { auditCatalog } = require('./catalog-audit.cjs')

const fixture = () => ({
	categories: [
		{
			_id: 'c1',
			slug: 'filament',
			required_attributes: [
				{ key: 'finish', label: 'Ефект', filter_type: 'multi-select', is_required: false }
			]
		}
	],
	products: [
		{
			_id: 'p1',
			category_id: 'c1',
			attributes: [
				{ k: 'finish', v: 'Silk' },
				{ k: 'finish', v: 'Rainbow' }
			],
			variant_type: { key: 'finish' }
		}
	],
	product_variants: [
		{
			_id: 'v1',
			product_id: 'p1',
			category_id: 'c1',
			sku: 'FL-1',
			slug: 'silk',
			status: 'active'
		}
	],
	landings: [
		{
			_id: 'l1',
			category_id: 'c1',
			slug: 'silk',
			filters: { finish: ['Silk'] },
			status: 'active'
		}
	],
	colors: []
})

test('valid legacy multi-values are preserved and route candidates keep SKU URLs', () => {
	const input = fixture()
	const before = JSON.stringify(input)
	const result = auditCatalog(input)
	assert.deepEqual(result.issues, [])
	assert.equal(JSON.stringify(input), before)
	assert.equal(result.route_candidates[0].to, '/catalog/filament')
	assert.equal(result.route_candidates[1].from, '/filament/silk')
	assert.equal(result.route_candidates[2].from, result.route_candidates[2].to)
})
test('incomplete snapshots fail rather than report an empty valid catalogue', () => {
	assert.throws(() => auditCatalog({ categories: [] }), /Missing collection/)
	const data = fixture()
	data.products.push(null)
	assert.throws(() => auditCatalog(data), /Invalid document/)
	const empty = { categories: [], products: [], product_variants: [], landings: [], colors: [] }
	assert.equal(auditCatalog(empty).issue_counts.incomplete_inventory, 1)
})
test('finds identity collisions and dangling references', () => {
	const data = fixture()
	data.product_variants.push({
		...data.product_variants[0],
		_id: 'v2',
		product_id: 'missing',
		color_id: 'bad'
	})
	const r = auditCatalog(data)
	assert.equal(r.issue_counts.duplicate_identity, 2)
	for (const code of ['orphan_product', 'orphan_color']) assert.equal(r.issue_counts[code], 1)
})
test('finds unstable definitions and pinned filter keys', () => {
	const data = fixture()
	data.categories[0].required_attributes.push(
		{ key: 'finish', filter_type: 'range' },
		{ key: 'page', filter_type: 'multi-select', is_required: true }
	)
	data.landings[0].filters = { retired_key: ['yes'] }
	const r = auditCatalog(data)
	for (const code of [
		'duplicate_attribute_key',
		'missing_requiredness',
		'reserved_attribute_key',
		'unknown_landing_key',
		'non_numeric_range'
	])
		assert.ok(r.issue_counts[code])
})
test('cycles and missing parents terminate with findings', () => {
	const data = fixture()
	data.categories[0].parent_id = 'c2'
	data.categories.push({ _id: 'c2', slug: 'group', parent_id: 'c1', required_attributes: [] })
	assert.equal(auditCatalog(data).issue_counts.category_cycle, 2)
	data.categories[1].parent_id = 'missing'
	assert.equal(auditCatalog(data).issue_counts.orphan_parent, 2)
})
test('recognizes Mongo extended JSON IDs without losing references', () => {
	const data = fixture()
	data.categories[0]._id = { $oid: 'c1' }
	data.products[0].category_id = { $oid: 'c1' }
	assert.deepEqual(auditCatalog(data).issues, [])
})
test('unregistered product attributes and commas are findings, not auto-rewrites', () => {
	const data = fixture()
	data.products[0].attributes.push({ k: 'diameter', v: '1,75' })
	data.product_variants[0].category_id = 'wrong'
	const r = auditCatalog(data)
	assert.equal(r.issue_counts.unregistered_attribute, 1)
	assert.equal(r.issue_counts.comma_in_value, 1)
	assert.equal(r.issue_counts.category_drift, 1)
})
