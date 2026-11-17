import { normalizeCatalogPath, reservedCategorySlug } from './catalog-route-plan'

it('normalizes equivalent encoding and trailing slashes', () => {
	expect(normalizeCatalogPath('/%66ilament/')).toBe('/filament')
	expect(normalizeCatalogPath('/каталог')).toBe('/%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3')
})

it('reserves the storefront first segments for categories (B07)', () => {
	for (const slug of [
		'admin',
		'checkout',
		'catalog',
		'products',
		'faq',
		'price-sheet',
		'sitemap'
	])
		expect(reservedCategorySlug(slug)).toBe(true)
	for (const slug of ['filament', 'catalog-x', 'product'])
		expect(reservedCategorySlug(slug)).toBe(false)
})

it('reserves `ancestors`: `/categories/slug/ancestors` would be read as `/categories/:id/ancestors` (P06)', () => {
	expect(reservedCategorySlug('ancestors')).toBe(true)
})
