import type { AttributeDefinition } from '../category/attribute-definitions'
import { typedVariantLabel } from './typed-product-detail'

/** One characteristic column of a price list. */
export interface PriceColumn {
	key: string
	label: string
}

interface PriceColumnsCategory {
	attribute_contract_version: number
	attribute_definitions: AttributeDefinition[]
}

/**
 * The characteristic columns of a category's price lists — the public price sheet and the admin
 * PDF (owner, 2026-11-06): what the catalogue filters the category by, i.e. every definition with
 * a filter and the colour (filtered by its dictionary family), in the category's order. A column
 * stays while every product shares one value — the next product may differ. A v1 category has
 * none: its price lists show the common columns only until it is migrated.
 */
export function priceColumnsOf(category: PriceColumnsCategory | undefined): PriceColumn[] {
	if (category?.attribute_contract_version !== 2) return []
	return [...category.attribute_definitions]
		.filter(definition => definition.filter_enabled || definition.semantic === 'color')
		.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
		.map(definition => ({ key: definition.key, label: definition.label }))
}

/**
 * One SKU's text per column: the product's values with the unit («1 кг»; several values of one
 * characteristic joined by «, »), and for its axis the SKU's own value — a colour axis as the
 * dictionary names it («Чорний (Black)»). A column without a value is absent.
 */
export function priceValuesOf(
	category: PriceColumnsCategory | undefined,
	row: {
		attributes_v2?: { k: string; v: unknown }[] | null
		variant_axis?: { key: string } | null
		variant_value?: unknown
		/** The SKU's dictionary colour, formatted. */
		color_label?: string | null
	}
): Record<string, string> {
	const columns = priceColumnsOf(category)
	if (!columns.length) return {}
	const definitions = new Map(category!.attribute_definitions.map(item => [item.key, item]))
	const values: Record<string, string> = {}
	for (const { key } of columns) {
		const definition = definitions.get(key)!
		const texts =
			key === row.variant_axis?.key
				? [
						definition.semantic === 'color'
							? (row.color_label ?? null)
							: typedVariantLabel(definition, row.variant_value)
					]
				: (row.attributes_v2 ?? [])
						.filter(entry => entry.k === key)
						.map(entry => typedVariantLabel(definition, entry.v))
		const shown = [...new Set(texts.filter((text): text is string => !!text))]
		if (shown.length) values[key] = shown.join(', ')
	}
	return values
}
