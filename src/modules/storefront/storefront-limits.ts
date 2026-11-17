/**
 * Storefront settings limits (Plan-0010 B09) — one place for the settings schema, its OpenAPI and
 * the listing: a product-list collection is read as `/products/catalog/v2` `filters.product_ids`,
 * so raising the products of a collection alone would make the home page's listing a 400. The
 * admin (fillando-fe `StorefrontSettings.tsx`) mirrors these.
 */
export const STOREFRONT_LIMITS = {
	/** Collections on the home page. */
	collections: 12,
	/** Products of one collection, in the admin's order. */
	collectionProducts: 24
} as const
