/**
 * Brand, material and colour are NOT stored fields — they are derived from
 * `product.attributes[]` by matching the human-entered label. Shared by the public
 * price sheet (`GET /products/price-sheet`) and the admin price list PDF, so both
 * features agree on what "a brand" or "a colour" is. Change the patterns here, not
 * at the call sites.
 */

export type AttrLike = { k?: string; l?: string; v?: string | number | boolean }

export const MANUFACTURER_PATTERNS = [/виробник/i, /manufactur/i, /бренд/i, /brand/i]
export const MATERIAL_PATTERNS = [/матер/i, /material/i]
export const COLOR_PATTERNS = [/колір/i, /цвіт/i, /color/i]
/**
 * Spec dimensions the Google Shopping title and highlights are built from. Matched by label
 * rather than by key: «Діаметр» has no entry in `ATTR_KEY_OVERRIDES`, so its key is whatever
 * transliteration the label produced on the last save and would move with a label edit.
 */
export const DIAMETER_PATTERNS = [/діаметр/i, /diameter/i]
export const FILAMENT_WEIGHT_PATTERNS = [/вага/i, /weight/i]

/** Whether an attribute's human label matches any of the patterns. */
export function matchesAttrLabel(attribute: AttrLike | null | undefined, patterns: RegExp[]) {
	return Boolean(attribute?.l) && patterns.some(rx => rx.test(attribute?.l as string))
}

/**
 * First attribute whose label matches any of the given patterns — the entry itself, because a
 * caller that prints the value usually needs its label or its unit too.
 */
export function pickAttrEntry<T extends AttrLike>(attributes: T[], patterns: RegExp[]): T | null {
	return attributes.find(a => matchesAttrLabel(a, patterns)) ?? null
}

/** First attribute whose label matches any of the given patterns → its value as string. */
export function pickAttr(attributes: AttrLike[], patterns: RegExp[]): string | null {
	const found = pickAttrEntry(attributes, patterns)
	return found?.v != null ? String(found.v) : null
}

/**
 * The material the shop states for a product — `g:material` in the Merchant feed and `material`
 * in the page's structured data, so the two never disagree: a v2 definition with the `material`
 * semantic first, then the filament `polymer` value, then a «Матеріал»-labelled characteristic.
 */
export function materialOf(semanticMaterial: string | null | undefined, attributes: AttrLike[]) {
	if (semanticMaterial) return semanticMaterial
	const polymer = attributes.find(attribute => attribute?.k === 'polymer')
	return polymer ? String(polymer.v) : pickAttr(attributes, MATERIAL_PATTERNS)
}

export function pickColor(
	vValue: string | null | undefined,
	attributes: AttrLike[],
	variantType?: { key?: string; label?: string } | null
): string | null {
	const variantIsColor = variantType?.label
		? COLOR_PATTERNS.some(rx => rx.test(variantType.label as string))
		: false

	// If the product's variant axis is colour, the variant value IS the colour.
	if (variantIsColor && vValue) return vValue
	// A size, length or current value is not a colour. Explicit colour attributes remain valid.
	return pickAttr(attributes, COLOR_PATTERNS)
}

/** Display a size/current/other variant independently from its actual colour. */
export function pickVariantLabel(
	value: string | null | undefined,
	variantType: { label?: string } | null | undefined,
	color: string | null
): string | null {
	const label = variantType?.label
	const variant = value?.trim() || null
	return label && !COLOR_PATTERNS.some(pattern => pattern.test(label))
		? (variant ?? color)
		: (color ?? variant)
}
