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

/** First attribute whose label matches any of the given patterns → its value as string. */
export function pickAttr(attributes: AttrLike[], patterns: RegExp[]): string | null {
	const found = attributes.find(a => a?.l && patterns.some(rx => rx.test(a.l as string)))
	return found?.v != null ? String(found.v) : null
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
	// Otherwise look for a colour attribute, then fall back to the variant value.
	return pickAttr(attributes, COLOR_PATTERNS) ?? vValue ?? null
}
