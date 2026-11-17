import type { AttributeDefinition } from '../category/attribute-definitions'

type Scalar = string | number | boolean

/**
 * The shopper-facing text of one typed value. An enum shows its option label — never the
 * stored option id — and a boolean reads «Так»/«Ні», the same wording the draft writer puts
 * into SKU names. `null` for a value the definition cannot express (an option removed from the
 * dictionary, a wrong scalar type): the row is dropped rather than printing an internal id.
 */
export function typedValueLabel(definition: AttributeDefinition, value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null
	if (definition.value_type === 'enum')
		return definition.options.find(option => option.id === value)?.label ?? null
	if (definition.value_type === 'boolean')
		return typeof value === 'boolean' ? (value ? 'Так' : 'Ні') : null
	if (definition.value_type === 'number')
		return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
	return typeof value === 'string' ? value : null
}

/** Axis value as it appears after the name: «63 А», «Чотири», «Так». */
export function typedVariantLabel(axis: AttributeDefinition | null, value: unknown): string | null {
	if (!axis) return null
	const label = typedValueLabel(axis, value)
	if (label === null) return null
	return axis.unit ? `${label} ${axis.unit}` : label
}

export interface TypedDetailInput {
	definitions: AttributeDefinition[]
	attributes_v2: { k: string; v: Scalar }[]
	variant_axis: { key: string } | null
	/** The axis value of the SKU this page is for. */
	variant_value: unknown
	/** Display text of the axis value when it is not the stored scalar (a dictionary colour). */
	axis_label?: string | null
}

/**
 * Specification rows in the legacy `{k,l,v,unit}` shape the storefront already renders
 * (TD-0013 «read adapter»): values formatted from the category definitions, the unit kept
 * separate so the table prints it once per value, hidden definitions omitted, the category
 * order kept. The axis row carries this SKU's own value, never a sibling's.
 */
export function typedSpecificationRows(input: TypedDetailInput) {
	const rows: { k: string; l: string; v: string; unit: string | null }[] = []
	const definitions = [...input.definitions].sort(
		(a, b) => a.order - b.order || a.key.localeCompare(b.key)
	)
	for (const definition of definitions) {
		if (!definition.visible_in_specs) continue
		const values =
			definition.key === input.variant_axis?.key
				? [input.variant_value]
				: input.attributes_v2.filter(row => row.k === definition.key).map(row => row.v)
		const seen = new Set<string>()
		const isAxis = definition.key === input.variant_axis?.key
		for (const value of values) {
			const label =
				isAxis && input.axis_label !== undefined
					? input.axis_label
					: typedValueLabel(definition, value)
			if (label === null || seen.has(label)) continue
			seen.add(label)
			rows.push({
				k: definition.key,
				l: definition.label,
				v: label,
				unit: isAxis && input.axis_label !== undefined ? null : definition.unit
			})
		}
	}
	return rows
}

/**
 * The text of the characteristic that declares a meaning (`size` / `material` / `brand`, Plan-0010
 * B10/F09; brand since 2026-11-05):
 * the SKU's axis value when the axis carries it, else the product's values; never found by label.
 * Shared by the Merchant feed (`g:size`, `g:material`) and the product page's structured data, so
 * the two cannot disagree.
 */
export function semanticValue(
	input: Omit<TypedDetailInput, 'axis_label'>,
	semantic: 'size' | 'material' | 'brand'
): string | null {
	const definition = input.definitions.find(item => item.semantic === semantic)
	if (!definition) return null
	if (definition.key === input.variant_axis?.key)
		return typedVariantLabel(definition, input.variant_value ?? null)
	const values = input.attributes_v2
		.filter(entry => entry.k === definition.key)
		.map(entry => typedValueLabel(definition, entry.v))
		.filter((value): value is string => value !== null)
	if (!values.length) return null
	const text = values.join(', ')
	return definition.unit && definition.value_type === 'number'
		? `${text} ${definition.unit}`
		: text
}
