import type { FeedVariantRow } from 'src/database/mongoose/repositories/product-variant.repository'
import type { AttributeDefinition } from '../category/attribute-definitions'
import {
	semanticValue,
	typedSpecificationRows,
	typedVariantLabel
} from '../product/typed-product-detail'

/** The public category of a row, as `CategoryPublicReadService` projects it. */
export interface FeedCategory {
	_id: string
	name: string
	attribute_contract_version: number
	attribute_definitions: AttributeDefinition[]
}

/**
 * A feed row of a v2 category in the shape the existing builder reads (TD-0013 B10, first step):
 * values formatted from the category definitions, the axis value as the variant label, the
 * definitions as the «required attributes» the warnings check. Colour stays empty — an arbitrary
 * axis is never sent as `color` — and v1 rows pass through untouched.
 *
 * Nothing here knows a category (owner, 2026-11-05): the brand is the linked brand entity, else
 * the characteristic marked `brand` — a hidden one counts, as filament's «Виробник» is hidden
 * from the table — and without either the builder excludes the SKU rather than invent one. The
 * highlights are the characteristics the product page shows, in the same order, without the
 * brand and the colour (they have fields of their own).
 */
export function adaptFeedRow(row: FeedVariantRow, category: FeedCategory): FeedVariantRow {
	if (category.attribute_contract_version !== 2 || !row.product) return row
	const definitions = category.attribute_definitions
	const axisKey = row.product.variant_axis?.key ?? null
	const axis = axisKey ? (definitions.find(item => item.key === axisKey) ?? null) : null
	// A colour axis stores the dictionary id: the feed keeps the dictionary colour and the
	// legacy `v_value` it always sent; any other axis is formatted and is never a colour.
	const colorAxis = axis?.semantic === 'color'
	const colorText = row.color
		? row.color.name_uk === row.color.name_en
			? row.color.name_uk
			: `${row.color.name_uk} (${row.color.name_en})`
		: row.v_value
	const specs = typedSpecificationRows({
		definitions,
		attributes_v2: row.product.attributes_v2 ?? [],
		variant_axis: axis ? { key: axis.key } : null,
		variant_value: row.variant_value ?? null,
		...(colorAxis ? { axis_label: colorText } : {})
	})
	// `g:size` / `g:material` from the definition that declares the meaning (Plan-0010 B10): the
	// product's value, or the SKU's axis value when the axis carries it; never from a label.
	const typedInput = {
		definitions,
		attributes_v2: row.product.attributes_v2 ?? [],
		variant_axis: axis ? { key: axis.key } : null,
		variant_value: row.variant_value ?? null
	}
	const brandKey = definitions.find(item => item.semantic === 'brand')?.key
	// One bullet per row of the page's table: a characteristic with several values is one row
	// («Ефект поверхні: Matte, Rainbow»), as the storefront merges it.
	const rows = new Map<string, { label: string; values: string[] }>()
	for (const spec of specs) {
		if (spec.k === brandKey || (colorAxis && spec.k === axis?.key)) continue
		const value = spec.unit ? `${spec.v} ${spec.unit}` : spec.v
		const row = rows.get(spec.k)
		if (row) row.values.push(value)
		else rows.set(spec.k, { label: spec.l, values: [value] })
	}
	const highlights = [...rows.values()].map(row => `${row.label}: ${row.values.join(', ')}`)
	return {
		...row,
		semantic: {
			size: semanticValue(typedInput, 'size'),
			material: semanticValue(typedInput, 'material'),
			brand: row.product.brand_name || semanticValue(typedInput, 'brand')
		},
		highlights,
		v_value: colorAxis ? row.v_value : typedVariantLabel(axis, row.variant_value ?? null),
		color: colorAxis ? row.color : null,
		product: {
			...row.product,
			// Bare values, as legacy rows store them: the builder appends the unit from
			// `required_attributes` below, so formatting it here printed «1.75 мм мм».
			attributes: specs.map(spec => ({ k: spec.k, l: spec.l, v: spec.v })),
			variant_type: axis ? { key: axis.key, label: axis.label } : null
		},
		category: row.category && {
			...row.category,
			required_attributes: definitions.map(item => ({
				key: item.key,
				label: item.label,
				is_required: item.is_required,
				unit: item.unit
			}))
		}
	}
}
