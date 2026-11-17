import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'
import { AttributeDefinition } from '../category/attribute-definitions'
import { parseAttributeFilters } from '../category/category-attribute-filters'
import { STOREFRONT_LIMITS } from '../storefront/storefront-limits'
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/)
const range = z
	.strictObject({
		min: z.number().nonnegative().optional(),
		max: z.number().nonnegative().optional()
	})
	.refine(v => v.min === undefined || v.max === undefined || v.min <= v.max)
const filtersSchema = z.strictObject({
	attributes: z.array(z.unknown()).default([]),
	category_ids: z.array(objectId).max(100).default([]),
	brand_ids: z.array(objectId).max(100).default([]),
	price: range.optional(),
	in_stock: z.boolean().optional(),
	color_families: z.array(z.string()).max(100).default([]),
	/** SKUs of these products only — a curated storefront collection (Plan-0010 B09). */
	product_ids: z.array(objectId).max(STOREFRONT_LIMITS.collectionProducts).default([]),
	/** SKUs on a live promotion only — the catalogue hub's «Акції» strip (Plan-0010 P20). */
	on_sale: z.literal(true).optional()
})
const querySchema = z.strictObject({
	category_id: objectId.optional(),
	page: z
		.string()
		.regex(/^[1-9]\d*$/)
		.default('1')
		.transform(Number)
		.pipe(z.number().safe().max(1000000)),
	limit: z
		.string()
		.regex(/^[1-9]\d*$/)
		.default('20')
		.transform(Number)
		.pipe(z.number().max(100)),
	sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
	filters: z
		.string()
		.refine(value => Buffer.byteLength(value) <= 16384)
		.default('{}')
})
export function parsePublicCatalogQuery(raw: unknown) {
	try {
		const query = querySchema.parse(raw)
		return { ...query, filters: filtersSchema.parse(JSON.parse(query.filters)) }
	} catch {
		throw new BadRequestException({
			message: 'Invalid catalog query',
			details: { code: 'INVALID_CATALOG_QUERY' }
		})
	}
}
/** A strip has no page and no order of its own: the first cards of the «newest» listing. */
const stripSchema = z.strictObject({
	category_id: objectId.optional(),
	limit: z
		.string()
		.regex(/^[1-9]\d*$/)
		.default('8')
		.transform(Number)
		.pipe(z.number().max(STOREFRONT_LIMITS.collectionProducts)),
	filters: z
		.string()
		.refine(value => Buffer.byteLength(value) <= 16384)
		.default('{}')
})
export function parseCatalogStripQuery(raw: unknown) {
	try {
		const query = stripSchema.parse(raw)
		return { ...query, filters: filtersSchema.parse(JSON.parse(query.filters)) }
	} catch {
		throw new BadRequestException({
			message: 'Invalid catalog query',
			details: { code: 'INVALID_CATALOG_QUERY' }
		})
	}
}
export type CatalogFilters = z.infer<typeof filtersSchema>
/** A stored catalogue `filters` object (a typed landing's `filters_v2`), never a query string. */
export function parseCatalogFilters(value: unknown): CatalogFilters {
	return filtersSchema.parse(value)
}
export function publicCatalogAttributes(definitions: AttributeDefinition[], attributes: unknown[]) {
	try {
		return parseAttributeFilters(definitions, { attributes })
	} catch {
		throw new BadRequestException({
			message: 'Invalid attribute filter',
			details: { code: 'INVALID_ATTRIBUTE_FILTER' }
		})
	}
}
