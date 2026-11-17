import { generateAttrKey } from 'src/common/utils/attribute.utils'
import type { AttributeDefinition } from '../category/attribute-definitions'
import { semanticValue, typedValueLabel, typedVariantLabel } from './typed-product-detail'

/** What the adapter needs of a public category (`CategoryPublicReadService` projection). */
export interface LegacyShapeCategory {
	attribute_contract_version: number
	attribute_definitions: AttributeDefinition[]
}

/** The typed fields of a product and its SKU, as stored. */
export interface TypedLegacySource {
	attributes_v2?: { k: string; v: unknown }[] | null
	variant_axis?: { key: string } | null
	variant_value?: unknown
	/** Legacy `v_value`: on a colour axis the dictionary `name_en` every export always sent. */
	v_value?: string | null
	/** Name of an active brand entity linked to the product, if any. */
	brand_name?: string | null
}

export interface LegacyShape {
	attributes: { k: string; l: string; v: string }[]
	variant: { key: string; label: string; value: string } | null
	/** The brand entity, else the characteristic marked `brand`; never a label match. */
	manufacturer: string | null
}

/**
 * A v2 product in the v1 shape the exports were built on (TD-0013 «legacy read adapter»):
 * the partner API, the admin price list PDF and the public price sheet. Their contracts stay
 * frozen, so a typed product answers with the same fields a legacy one does:
 *
 * - `attributes` — every characteristic in its stored order, labelled from the definition, the
 *   value as text (an enum option label, «Так»/«Ні», a number as written — never an option id).
 *   Nothing is hidden: «У таблиці характеристик» decides the product page's table only, and the
 *   exports never hid «Матеріал» or «Виробник» (owner, 2026-11-05 — one visibility switch). A
 *   value the definition can no longer express is dropped rather than printed raw.
 *   A linked active brand
 *   entity is reported first as a «Виробник» row (key `brand`), so it wins a label match.
 * - `variant` — a colour axis answers as legacy did: the key derived from its label (`Колір` →
 *   `kolir`, the v1 identity of colour; the v2 key `color` is internal) and the dictionary
 *   `name_en` from `v_value`. Any other axis keeps its stable key and its formatted value
 *   («63 А») and is never presented as a colour.
 *
 * For the migrated filament this reproduces the legacy payload, except that the stale
 * product-level «Колір» copy is no longer listed on products with a colour axis (owner decision
 * 2026-10-27: it named one sibling's colour on every SKU). The partner card puts the row back
 * with the SKU's own colour (`withAxisColourRow`); the PDF and the price sheet never printed it.
 */
export function legacyShapeOf(
	category: LegacyShapeCategory,
	source: TypedLegacySource
): LegacyShape {
	const definitions = new Map(category.attribute_definitions.map(item => [item.key, item]))
	// First, so a label match («Виробник») finds the entity before the characteristic — the
	// product page's rule: a linked brand entity wins over the characteristic.
	const attributes: LegacyShape['attributes'] = source.brand_name
		? [{ k: 'brand', l: 'Виробник', v: source.brand_name }]
		: []
	for (const row of source.attributes_v2 ?? []) {
		const definition = definitions.get(row.k)
		if (!definition) continue
		const value = typedValueLabel(definition, row.v)
		if (value !== null) attributes.push({ k: definition.key, l: definition.label, v: value })
	}
	const axis = source.variant_axis ? (definitions.get(source.variant_axis.key) ?? null) : null
	let variant: LegacyShape['variant'] = null
	if (axis?.semantic === 'color') {
		if (source.v_value)
			variant = { key: generateAttrKey(axis.label), label: axis.label, value: source.v_value }
	} else if (axis) {
		const value = typedVariantLabel(axis, source.variant_value)
		if (value !== null) variant = { key: axis.key, label: axis.label, value }
	}
	const manufacturer =
		source.brand_name ||
		semanticValue(
			{
				definitions: category.attribute_definitions,
				attributes_v2: (source.attributes_v2 ?? []) as { k: string; v: string }[],
				variant_axis: source.variant_axis ?? null,
				variant_value: source.variant_value
			},
			'brand'
		)
	return { attributes, variant, manufacturer }
}

/**
 * Partner cards (owner decision 2026-10-28): a colour-axis SKU lists its own dictionary colour as
 * the product-level «Колір» row legacy cards carried — same key (`kolir`, from the axis label),
 * label and Ukrainian name, but the SKU's colour instead of the stale copy of one sibling's.
 * Any row with that key is replaced. Placed where the legacy rollback image had it (after the
 * nearest preceding characteristic the card still has), so a migrated card keeps the legacy order; without that image
 * (a product created in the new admin) the row goes last.
 */
export function withAxisColourRow(
	attributes: LegacyShape['attributes'],
	category: LegacyShapeCategory,
	source: {
		variant_axis?: { key: string } | null
		/** The SKU's dictionary `name_uk`. */
		colour_name?: string | null
		/** Legacy `attributes` of the product, if it still carries them. */
		legacy_attributes?: { k: string }[] | null
	}
): LegacyShape['attributes'] {
	const axis = source.variant_axis
		? category.attribute_definitions.find(item => item.key === source.variant_axis!.key)
		: undefined
	if (axis?.semantic !== 'color' || !source.colour_name) return attributes
	const key = generateAttrKey(axis.label)
	const rows = attributes.filter(row => row.k !== key)
	const legacy = source.legacy_attributes ?? []
	const at = legacy.findIndex(row => row.k === key)
	let index = rows.length
	if (at >= 0) {
		// After the nearest earlier legacy row the card still has: a characteristic the migration
		// did not carry over («Матеріал», owner 2026-11-06) must not move the colour to the end.
		index = rows[0]?.k === 'brand' ? 1 : 0
		for (let earlier = at - 1; earlier >= 0; earlier--) {
			const previous = rows.findIndex(row => row.k === legacy[earlier].k)
			if (previous >= 0) {
				index = previous + 1
				break
			}
		}
	}
	rows.splice(index, 0, { k: key, l: axis.label, v: source.colour_name })
	return rows
}

/** `legacyShapeOf` only for a v2 category; a v1 row keeps its stored legacy fields. */
export function isTypedCategory(
	category: LegacyShapeCategory | null | undefined
): category is LegacyShapeCategory {
	return category?.attribute_contract_version === 2
}
