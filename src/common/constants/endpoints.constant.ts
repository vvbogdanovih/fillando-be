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
		ME: '/me'
	},
	CATEGORIES: {
		BASE: '/categories',
		GET_ALL: '/',
		GET_WITH_SUBCATEGORIES: '/with-subcategories',
		GET_BY_SLUG: '/slug/:slug',
		GET_BY_ID: '/:id',
		CREATE: '/',
		UPDATE: '/:id',
		REPLACE: '/:id',
		DELETE: '/:id',
		GET_SUBCATEGORIES: '/:id/subcategories',
		GET_SUBCATEGORY_BY_ID: '/:id/subcategories/:subId',
		ADD_SUBCATEGORY: '/:id/subcategories',
		UPDATE_SUBCATEGORY: '/:id/subcategories/:subId',
		REPLACE_SUBCATEGORY: '/:id/subcategories/:subId',
		REMOVE_SUBCATEGORY: '/:id/subcategories/:subId'
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
		VARIANT_SLUGS: '/variants/slugs',
		VARIANT_COUNT: '/variants/count',
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
	ORDERS: {
		BASE: '/orders',
		CREATE: '/',
		MY: '/me',
		MY_BY_ID: '/me/:id',
		GET_ALL: '/',
		GET_BY_ID: '/:id',
		UPDATE: '/:id',
		UPDATE_ORDER_STATUS: '/:id/status',
		UPDATE_PAYMENT_STATUS: '/:id/payment-status',
		SET_TTN: '/:id/ttn'
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
