export type CatalogEntity = 'category' | 'landing' | 'variant'
export class CatalogRouteError extends Error {
	constructor(
		readonly code: string,
		readonly path: string
	) {
		super(`${code}: ${path}`)
	}
}

/** Decode once, reject ambiguous separators, then use one canonical percent encoding. */
export function normalizeCatalogPath(path: string): string {
	const invalid = () => {
		throw new CatalogRouteError('INVALID_ROUTE_PATH', path)
	}
	if (
		typeof path !== 'string' ||
		!path.startsWith('/') ||
		path.startsWith('//') ||
		path.length > 2048
	)
		return invalid()
	const segments = path.replace(/\/$/, '').slice(1).split('/')
	if (!segments.length || segments.some(segment => !segment)) return invalid()
	const normalized = segments.map(segment => {
		let decoded: string
		try {
			decoded = decodeURIComponent(segment).normalize('NFC')
		} catch {
			return invalid()
		}
		if (decoded === '.' || decoded === '..' || /[\s\p{Cc}\p{Cf}\\/%?#:]/u.test(decoded))
			return invalid()
		return encodeURIComponent(decoded)
	})
	return `/${normalized.join('/')}`
}

/**
 * First path segments the storefront owns; never a category address. A new top-level route in
 * fillando-fe (`src/app`, `src/app/(root)`) belongs here as well.
 */
export const RESERVED_ROOTS: ReadonlySet<string> = new Set([
	'admin',
	'auth',
	'checkout',
	'account',
	'profile',
	'search',
	'api',
	'_next',
	'contacts',
	'faq',
	'offer',
	'privacy',
	'returns',
	'price-sheet',
	'wholesale',
	'robots.txt',
	'sitemap.xml',
	// The sitemap's parts, `/sitemap/<part>` (Plan-0010 D06): a category `sitemap` would still open,
	// but every landing under it, `/sitemap/<landing>`, would be that route's 404 (audit 11.11).
	'sitemap'
])
/**
 * A category address `/{slug}` the storefront owns: its own routes, `/catalog`, `/products` — and
 * `ancestors`, which the API cannot read by slug: `GET /categories/slug/ancestors` matches
 * `/categories/:id/ancestors` first (that controller must stay ahead for `/options`).
 */
export function reservedCategorySlug(slug: string): boolean {
	return (
		RESERVED_ROOTS.has(slug) ||
		slug === 'catalog' ||
		slug === 'products' ||
		slug === 'ancestors'
	)
}
