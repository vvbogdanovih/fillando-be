export const ENDPOINTS = {
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
		BASE: '/categories',
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
		DELETE: '/:id'
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
		BASE: '/products',
		GET_ALL: '/',
		CATALOG: '/catalog',
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
	ORDERS: {
		BASE: '/orders',
		CREATE: '/',
		MY: '/me',
		MY_BY_ID: '/me/:id',
		LOOKUP: '/lookup/:orderNumber',
		GET_ALL: '/',
		GET_BY_ID: '/:id',
		UPDATE: '/:id',
		UPDATE_ORDER_STATUS: '/:id/status',
		UPDATE_PAYMENT_STATUS: '/:id/payment-status',
		SET_TTN: '/:id/ttn',
		GENERATE_INVOICE: '/:id/invoice',
		SEND_VENDOR_EMAIL: '/:id/vendor-email',
		GENERATE_REPORT: '/report'
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
