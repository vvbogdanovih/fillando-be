import { productReadiness } from './product-readiness'
import type { AttributeDefinition } from '../category/attribute-definitions'
const definition: AttributeDefinition = {
	key: 'automatic',
	label: 'Автоматичний',
	value_type: 'boolean',
	unit: null,
	is_required: true,
	filter_enabled: false,
	filter_type: null,
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: []
}
const input = () => ({
	definitions: [definition],
	attributes: [{ k: 'automatic', v: false }],
	axisKey: undefined as string | undefined,
	description: { html: '<p>Опис</p>' },
	variants: [
		{
			id: 'sku',
			status: 'draft',
			price: 100,
			stock: 0,
			images: ['https://example.com/image.webp'],
			weight_g: 1000 as number | null
		}
	]
})
it('accepts false and zero stock without treating them as missing', () =>
	expect(productReadiness(input())).toEqual({ data_ready: true, issues: [], warnings: [] }))
it('reports missing required attributes separately from the selected axis', () => {
	const data = input()
	data.attributes = []
	expect(productReadiness(data).issues).toContainEqual({
		code: 'REQUIRED_ATTRIBUTE',
		field: 'automatic'
	})
	data.axisKey = 'automatic'
	expect(productReadiness(data).data_ready).toBe(true)
})
it.each(['<p><br></p>', '<p>&nbsp;</p>', '<script>bad()</script>'])(
	'rejects an empty or stripped description %s',
	html => {
		const data = input()
		data.description = { html }
		expect(productReadiness(data).issues).toContainEqual({
			code: 'DESCRIPTION_REQUIRED',
			field: 'description'
		})
	}
)
it('requires a nonarchived draft and does not request content for archived SKUs', () => {
	const data = input()
	data.variants[0].status = 'archived'
	data.variants[0].price = 0
	data.variants[0].images = []
	expect(productReadiness(data).issues).toEqual([
		{ code: 'DRAFT_VARIANT_REQUIRED', field: 'variants' }
	])
})
it('reports price, stock and image problems without writing or mutating its input', () => {
	const data = input()
	data.variants[0].price = 0
	data.variants[0].stock = -1
	data.variants[0].images = ['javascript:alert(1)']
	const before = structuredClone(data)
	expect(productReadiness(data).issues.map(row => row.code)).toEqual([
		'POSITIVE_PRICE_REQUIRED',
		'VALID_STOCK_REQUIRED',
		'IMAGE_REQUIRED'
	])
	expect(data).toEqual(before)
})
it('keeps unknown shipping weight a warning and never supplies a false zero', () => {
	const data = input()
	data.variants[0].weight_g = null
	expect(productReadiness(data)).toEqual({
		data_ready: true,
		issues: [],
		warnings: [{ code: 'SHIPPING_WEIGHT_UNKNOWN', field: 'weight_g', variant_id: 'sku' }]
	})
})
