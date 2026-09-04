const CYRILLIC_MAP: Record<string, string> = {
	а: 'a',
	б: 'b',
	в: 'v',
	г: 'h',
	ґ: 'g',
	д: 'd',
	е: 'e',
	є: 'ie',
	ж: 'zh',
	з: 'z',
	и: 'y',
	і: 'i',
	ї: 'i',
	й: 'y',
	к: 'k',
	л: 'l',
	м: 'm',
	н: 'n',
	о: 'o',
	п: 'p',
	р: 'r',
	с: 's',
	т: 't',
	у: 'u',
	ф: 'f',
	х: 'kh',
	ц: 'ts',
	ч: 'ch',
	ш: 'sh',
	щ: 'shch',
	ь: '',
	ю: 'iu',
	я: 'ia'
}

/**
 * Explicit label → key overrides, consulted BEFORE transliteration.
 *
 * These keys are catalogue filter dimensions (TD-0002 §5.2.1): migrations write them,
 * landings pin them and the storefront filters by them, so they must be stable English
 * identifiers, not transliterated Ukrainian (`Серія` → `series`, never `seriia`).
 * Every place that derives a key from a label goes through `generateAttrKey`
 * (ProductService.create/update, CategoryService.mapRequiredAttributes), so this table
 * covers all of them.
 *
 * The frontend must keep an identical copy in `fillando-fe/src/common/utils/slug.utils.ts`
 * (`toAttrKey`), and `scripts/migrations/normalize-attr-keys.js` duplicates it to rename
 * keys already stored in the database — change all three together.
 */
export const ATTR_KEY_OVERRIDES: Readonly<Record<string, string>> = {
	'тип пластику': 'polymer',
	'ефект поверхні': 'finish',
	армування: 'reinforcement',
	серія: 'series',
	'котушка в комплекті': 'spool_included'
}

/** Lookup form for `ATTR_KEY_OVERRIDES`: NFC, trimmed, single-spaced, lower-case. */
export function normalizeAttrLabel(label: string): string {
	return label.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function generateAttrKey(label: string): string {
	const normalized = normalizeAttrLabel(label)
	if (Object.hasOwn(ATTR_KEY_OVERRIDES, normalized)) return ATTR_KEY_OVERRIDES[normalized]

	return label
		.normalize('NFD')
		.toLowerCase()
		.split('')
		.map(ch => CYRILLIC_MAP[ch] ?? ch)
		.join('')
		.replace(/[\s-]+/g, '_')
		.replace(/[^a-z0-9_]/g, '')
}

export function generateSlug(text: string): string {
	return text
		.normalize('NFD')
		.toLowerCase()
		.split('')
		.map(ch => CYRILLIC_MAP[ch] ?? ch)
		.join('')
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}
