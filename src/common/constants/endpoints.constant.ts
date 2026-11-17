export const ENDPOINTS = {
	CATALOG_OPERATIONS: { BASE: '/catalog-operations', STATUS: ':id' },
	CATALOG_EXPORT: { BASE: '/catalog', SITEMAP: '/sitemap', SITEMAP_PART: '/sitemap/part' },
	PARTNER_API: {
		BASE: '/partner/v1',
		CATEGORIES: '/categories',
		SKUS: '/products/skus',
		LOOKUP: '/products/lookup',
		AVAILABILITY: '/products/:sku/availability',
		BULK_AVAILABILITY: '/products/availability'
	},
	PARTNER_TOKENS: { BASE: '/admin/api-tokens', REVOKE: '/:id' },
	AUTH: {
		BASE: '/auth',
		ME: '/me',
		LOGIN: '/login',
		REGISTER: '/register',
		REFRESH: '/refresh',
		GOOGLE: '/google',
		GOOGLE_CALLBACK: '/google/callback',
		LOGOUT: '/logout'
	},
	USERS: {
		BASE: '/users',
		GET_ALL: '/',
		ME: '/me'
	},
	CATEGORIES: {
		DRAFT_CREATE: '/drafts',
		ADMIN_DEFINITIONS: ':id/admin/definitions',
		ADMIN_DEFINITION_USAGE: ':id/admin/definition-usage',
		ADMIN_FILTER_PREVIEW: ':id/admin/filter-preview',
		ADMIN_CONFIGURATION: ':id/admin/configuration',
		ADMIN_DETAILS: ':id/admin/details',
		ADMIN_CAPABILITIES: '/admin/capabilities',
		DRAFT_PLACEMENT: ':id/draft-placement',
		DRAFT_DELETION: ':id/admin/deletion',
		DRAFT_CONVERSION: ':id/admin/conversion',
		ADMIN_CONVERSION_PLAN: ':id/admin/conversion-plan',
		ADMIN_SEO: ':id/admin/seo',
		ADMIN_EXPORT: ':id/admin/export',
		ADMIN_PUBLICATION: ':id/admin/publication',
		BASE: '/categories',
		TREE: '/tree',
		CHILDREN: '/children',
		// Before GET_BY_ID: '/options' would otherwise be read as an id.
		OPTIONS: '/options',
		ANCESTORS: '/:id/ancestors',
		ADMIN_TREE: '/admin/tree',
		GET_ALL: '/',
		GET_BY_SLUG: '/slug/:slug',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		REPLACE: '/:id',
		DELETE: '/:id'
	},
	COLORS: {
		BASE: '/colors',
		GET_ALL: '/',
		// Declared before GET_BY_ID in the controller — '/admin' would otherwise be swallowed
		// by the ':id' parameter route.
		GET_ADMIN_ALL: '/admin',
		// New admin (journal-backed, works after the catalogue control exists).
		ADMIN_ENTRIES: '/admin/entries',
		ADMIN_ENTRY: '/:id/admin',
		ADMIN_DELETION: '/:id/admin/deletion',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		DELETE: '/:id'
	},
	LANDINGS: {
		BASE: '/landings',
		GET_ALL: '/',
		// Declared before GET_BY_ID in the controller — '/slugs' and '/admin' would otherwise
		// be swallowed by the ':id' parameter route.
		GET_SLUGS: '/slugs',
		GET_ADMIN_ALL: '/admin',
		GET_BY_SLUG: '/slug/:categorySlug/:landingSlug',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		DELETE: '/:id',
		// Typed landings of v2 categories (Plan-0010 F07): a separate, journal-backed controller.
		TYPED_ADMIN: '/admin/typed',
		TYPED_ADMIN_ITEM: '/:id/admin/typed',
		TYPED_ADMIN_DELETION: '/:id/admin/deletion'
	},
	CATALOG_ROUTES: {
		BASE: '/routes',
		RESOLVE: '/resolve',
		VARIANT_SLUG: '/variants/:id/slug-change',
		CATEGORY_SLUG: '/categories/:id/slug-change',
		LANDING_SLUG: '/landings/:id/slug-change'
	},
	STOREFRONT_SETTINGS: {
		BASE: '/storefront-settings',
		ADMIN: '/admin'
	},
	VENDORS: {
		BASE: '/vendors',
		GET_ALL: '/',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		DELETE: '/:id',
		CHECK_AVAILABILITY: '/check-availability'
	},
	PRODUCTS: {
		TYPED_DRAFT_LIST: '/admin/typed-drafts',
		TYPED_DRAFT: '/:id/admin/typed-draft',
		TYPED_TRANSFER: '/:id/admin/transfer',
		TYPED_DELETION: '/:id/admin/deletion',
		BASE: '/products',
		GET_ALL: '/',
		CATALOG: '/catalog',
		CATALOG_V2: '/catalog/v2',
		CATALOG_V2_CATEGORY_COUNTS: '/catalog/v2/category-counts',
		CATALOG_V2_STRIP: '/catalog/v2/strip',
		SEARCH: '/search',
		VARIANT_SLUGS: '/variants/slugs',
		VARIANT_COUNT: '/variants/count',
		PRICE_SHEET: '/price-sheet',
		PRICE_LIST_PDF: '/price-list/pdf',
		BY_SLUG: '/by-slug/:slug',
		GET_BY_ID: '/:id',
		CREATE: '/',
		VALIDATE: '/validate',
		UPDATE: '/:id',
		DELETE: '/:id',
		VARIANTS: '/:id/variants',
		PROMOTION: '/:id/promotion',
		VARIANT: '/:id/variants/:variantId',
		PATCH_VARIANT_IMAGES: '/:id/variants/:variantId/images'
	},
	UPLOAD: {
		BASE: '/upload',
		PRESIGN: '/presign',
		CONFIRM: '/confirm',
		DELETE: '/'
	},
	CART: {
		BASE: '/cart',
		GET: '/',
		MERGE: '/merge',
		ADD_ITEM: '/items',
		UPDATE_ITEM: '/items/:variantId',
		REMOVE_ITEM: '/items/:variantId',
		CLEAR: '/'
	},
	NOVA_POST: {
		BASE: '/nova-post',
		SYNC: '/sync',
		CITIES: '/cities',
		WAREHOUSES: '/warehouses'
	},
	PROM: {
		BASE: '/prom',
		SYNC_AVAILABILITY: '/sync-availability'
	},
	FEEDS: {
		BASE: '/feeds',
		/** Public — registered in Merchant Center as the feed URL. */
		GOOGLE_SHOPPING_XML: '/google-shopping.xml',
		GOOGLE_SHOPPING_REGENERATE: '/google-shopping/regenerate',
		GOOGLE_SHOPPING_STATUS: '/google-shopping/status'
	},
	ORDERS: {
		BASE: '/orders',
		CREATE: '/',
		MY: '/me',
		MY_BY_ID: '/me/:id',
		LOOKUP: '/lookup/:orderNumber',
		LOOKUP_PAYMENT_METHOD: '/lookup/:orderNumber/payment-method',
		MY_PAYMENT_METHOD: '/me/:id/payment-method',
		GET_ALL: '/',
		GET_BY_ID: '/:id',
		UPDATE: '/:id',
		UPDATE_ORDER_STATUS: '/:id/status',
		UPDATE_PAYMENT_STATUS: '/:id/payment-status',
		SET_TTN: '/:id/ttn',
		GENERATE_INVOICE: '/:id/invoice',
		SEND_VENDOR_EMAIL: '/:id/vendor-email',
		GENERATE_REPORT: '/report',
		STATS: '/stats'
	},
	PAYMENT_DETAILS: {
		BASE: '/payment-details',
		GET_ALL: '/',
		GET_ACTIVE: '/active',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		DELETE: '/:id',
		ACTIVATE: '/:id/activate'
	},
	PAYMENT_PROVIDERS: {
		BASE: '/payment-providers',
		GET_ALL: '/',
		GET_ACTIVE: '/active/:provider',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		DELETE: '/:id',
		ACTIVATE: '/:id/activate'
	},
	LIQPAY: {
		BASE: '/liqpay',
		CHECKOUT: '/checkout',
		CALLBACK: '/callback'
	},
	WHOLESALE_INQUIRIES: {
		BASE: '/wholesale-inquiries',
		CREATE: '/',
		GET_ALL: '/',
		UPDATE_STATUS: '/:id/status'
	},
	DISCOUNT_COUPONS: {
		BASE: '/discount-coupons',
		GET_ALL: '/',
		GET_BY_ID: '/:id',
		CREATE: '/',
		VALIDATE: '/validate',
		UPDATE: '/:id',
		DELETE: '/:id'
	}
} as const
