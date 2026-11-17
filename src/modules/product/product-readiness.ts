import { sanitizeRichText } from 'src/common/utils/html.utils'
import type { AttributeDefinition } from '../category/attribute-definitions'
export interface ReadinessIssue {
	code: string
	field: string
	variant_id?: string
}
export function productReadiness(input: {
	definitions: AttributeDefinition[]
	attributes: { k: string; v: unknown }[]
	axisKey?: string
	description: unknown
	variants: {
		id: string
		status: string
		price: unknown
		stock: unknown
		images: unknown
		weight_g: unknown
	}[]
}) {
	const issues: ReadinessIssue[] = [],
		warnings: ReadinessIssue[] = []
	for (const def of input.definitions)
		if (
			def.is_required &&
			def.key !== input.axisKey &&
			!input.attributes.some(row => row.k === def.key)
		)
			issues.push({ code: 'REQUIRED_ATTRIBUTE', field: def.key })
	const description = input.description as { html?: unknown } | null
	const html = typeof description?.html === 'string' ? sanitizeRichText(description.html) : ''
	if (
		!html
			.replace(/<[^>]*>/g, ' ')
			.replace(/&(?:nbsp|#160|#xA0);/gi, ' ')
			.trim()
	)
		issues.push({ code: 'DESCRIPTION_REQUIRED', field: 'description' })
	// Draft SKUs before publication, and the live ones of a published product.
	const candidates = input.variants.filter(
		row => row.status === 'draft' || row.status === 'active'
	)
	if (!candidates.length) issues.push({ code: 'DRAFT_VARIANT_REQUIRED', field: 'variants' })
	for (const row of candidates) {
		const add = (code: string, field: string) =>
			issues.push({ code, field, variant_id: row.id })
		if (
			typeof row.price !== 'number' ||
			!Number.isFinite(row.price) ||
			row.price <= 0 ||
			row.price > 1000000000
		)
			add('POSITIVE_PRICE_REQUIRED', 'price')
		if (typeof row.stock !== 'number' || !Number.isSafeInteger(row.stock) || row.stock < 0)
			add('VALID_STOCK_REQUIRED', 'stock')
		if (
			!Array.isArray(row.images) ||
			row.images.length === 0 ||
			row.images.some(image => {
				if (typeof image !== 'string') return true
				try {
					return !['http:', 'https:'].includes(new URL(image).protocol)
				} catch {
					return true
				}
			})
		)
			add('IMAGE_REQUIRED', 'images')
		if (
			typeof row.weight_g !== 'number' ||
			!Number.isSafeInteger(row.weight_g) ||
			row.weight_g <= 0
		)
			warnings.push({
				code: 'SHIPPING_WEIGHT_UNKNOWN',
				field: 'weight_g',
				variant_id: row.id
			})
	}
	return { data_ready: issues.length === 0, issues, warnings }
}
