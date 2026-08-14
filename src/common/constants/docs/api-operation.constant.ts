/**
 * Swagger/OpenAPI operation metadata (summary, description) for API endpoints.
 * Used with @ApiOperation() in controllers to keep docs in one place.
 */
export const API_OPERATION = {
	AUTH: {
		ME: {
			summary: 'Get me',
			description: 'Get user'
		},
		LOGIN: {
			summary: 'Login',
			description: 'Login user'
		},
		REGISTER: {
			summary: 'Register',
			description: 'Register user'
		},
		REFRESH: {
			summary: 'Refresh access token',
			description: 'Refresh access token'
		},
		GOOGLE: {
			summary: 'Google login',
			description: 'Google login'
		},
		GOOGLE_CALLBACK: {
			summary: 'Google callback',
			description: 'Google callback'
		},
		LOGOUT: {
			summary: 'Logout',
			description: 'Logout user'
		}
	},
	USERS: {
		GET_ALL: {
			summary: 'Get all users',
			description: 'Paginated list of all users with optional role filter. Admin only.'
		},
		ME: {
			summary: 'Get my profile',
			description: 'Returns the profile of the authenticated user'
		},
		UPDATE_ME: {
			summary: 'Update my profile',
			description: 'Updates name, phone, or profile picture for the authenticated user'
		}
	},
	CATEGORIES: {
		GET_ALL: {
			summary: 'Get all categories',
			description: 'Get all categories'
		},
		GET_BY_SLUG: {
			summary: 'Get category by slug',
			description: 'Get a single category (with its filter attributes) by slug'
		},
		GET_BY_ID: {
			summary: 'Get category by id',
			description: 'Get a single category by id'
		},
		CREATE: {
			summary: 'Create category',
			description: 'Create a new category'
		},
		UPDATE: {
			summary: 'Update category',
			description: 'Update an existing category'
		},
		DELETE: {
			summary: 'Delete category',
			description: 'Delete a category'
		},
		REPLACE: {
			summary: 'Replace category',
			description: 'Fully replace a category (all fields required)'
		}
	},
	VENDORS: {
		GET_ALL: {
			summary: 'Get all vendors',
			description: 'Get all vendors'
		},
		GET_BY_ID: {
			summary: 'Get vendor by id',
			description: 'Get a single vendor by id'
		},
		CREATE: {
			summary: 'Create vendor',
			description: 'Create a new vendor'
		},
		UPDATE: {
			summary: 'Update vendor',
			description: 'Update an existing vendor'
		},
		DELETE: {
			summary: 'Delete vendor',
			description: 'Delete a vendor'
		},
		CHECK_AVAILABILITY: {
			summary: 'Check vendor availability',
			description: 'Check if a vendor name or slug is available (not taken)'
		}
	},
	PRODUCTS: {
		GET_ALL: {
			summary: 'Get all products',
			description: 'Get all products'
		},
		GET_BY_ID: {
			summary: 'Get product by id',
			description: 'Get a single product by id'
		},
		CREATE: {
			summary: 'Create product',
			description: 'Create a new product'
		},
		UPDATE: {
			summary: 'Update product',
			description: 'Update an existing product'
		},
		DELETE: {
			summary: 'Delete product',
			description: 'Delete a product'
		},
		VALIDATE: {
			summary: 'Validate slugs and SKUs',
			description:
				'Check which slugs and SKUs are already taken. Returns arrays of taken values.'
		},
		PATCH_VARIANT_IMAGES: {
			summary: 'Set variant images',
			description: 'Replace the images array on a specific product variant.'
		},
		GET_VARIANTS: {
			summary: 'Get product variants',
			description: 'Get all variants belonging to a product.'
		},
		GET_VARIANT: {
			summary: 'Get variant by id',
			description: 'Get a single product variant by id.'
		},
		ADD_VARIANT: {
			summary: 'Add variant to product',
			description: 'Create a new variant for an existing product.'
		},
		UPDATE_VARIANT: {
			summary: 'Update variant',
			description: 'Partially update a product variant (price, stock, status, etc.).'
		},
		DELETE_VARIANT: {
			summary: 'Delete variant',
			description: 'Delete a specific product variant.'
		},
		CATALOG: {
			summary: 'Get catalog products',
			description: 'Paginated, filterable product listing for a given category.'
		},
		SEARCH: {
			summary: 'Search products',
			description:
				'Full-text search across product names, descriptions, and attributes. Also matches variant SKU prefixes. Returns paginated results.'
		},
		VARIANT_SLUGS: {
			summary: 'Get all variant slugs',
			description: 'Returns minimal variant data for sitemap generation (slug and updatedAt).'
		},
		VARIANT_COUNT: {
			summary: 'Get variants count',
			description: 'Returns total number of product variants.'
		},
		PRICE_SHEET: {
			summary: 'Price sheet (flat variant list)',
			description:
				'Public paginated flat list of all product variants for the price-sheet table. Sorted by availability (in stock first), then name. Supports `q` search by product name, vendor article, SKU or attribute value.'
		},
		BY_SLUG: {
			summary: 'Get variant by slug',
			description:
				'Returns full variant info, parent product, and sibling variants by variant slug.'
		}
	},
	UPLOAD: {
		PRESIGN: {
			summary: 'Generate presigned upload URLs',
			description:
				'Returns presigned S3 PUT URLs and public URLs for direct client-side upload. URLs expire in 15 minutes.'
		},
		CONFIRM: {
			summary: 'Confirm uploaded files',
			description:
				'Verifies that files were successfully uploaded to S3 via headObject checks.'
		},
		DELETE: {
			summary: 'Delete files from S3',
			description: 'Permanently deletes one or more files from S3 by their keys.'
		}
	},
	CART: {
		GET: {
			summary: 'Get cart',
			description:
				"Returns the current user's cart with populated variant data. Out-of-stock items are automatically removed and listed in removed_items."
		},
		MERGE: {
			summary: 'Merge cart',
			description:
				'Called after login to sync the client-side cart. If the server cart is empty, client items are validated against stock and set. If the server cart already has items, it is returned as-is and the client-side cart is discarded.'
		},
		ADD_ITEM: {
			summary: 'Add item to cart',
			description:
				'Add a variant to the cart. If the variant is already present, its quantity is incremented by the given amount. Stock is validated.'
		},
		UPDATE_ITEM: {
			summary: 'Update cart item quantity',
			description: 'Set the absolute quantity for a specific cart item. Stock is validated.'
		},
		REMOVE_ITEM: {
			summary: 'Remove item from cart',
			description: 'Remove a specific variant from the cart.'
		},
		CLEAR: {
			summary: 'Clear cart',
			description: 'Remove all items from the cart.'
		}
	},
	NOVA_POST: {
		SYNC: {
			summary: 'Sync Nova Post data',
			description:
				'Fetches all cities and warehouses from the Nova Post API and upserts them into the local database. Admin only. Returns counts of processed records.'
		},
		CITIES: {
			summary: 'Search cities',
			description: 'Case-insensitive search for Nova Post cities/settlements by name.'
		},
		WAREHOUSES: {
			summary: 'Get warehouses by city',
			description:
				'Returns Nova Post warehouses for the given city ref. Optional `type` filter: PARCEL_LOCKER (поштомат), POST (поштове відділення), CARGO (вантажне відділення). Optional `q` (same idea as on `/nova-post/cities`): when non-empty after trim, returns only branches where the substring appears in the warehouse number (string form), `description`, or `shortAddress` — case-insensitive for text, with whitespace normalized in the query and flexible matching between words. When `q` is omitted or only whitespace, returns the full list for `cityRef` + `type` as before.'
		}
	},
	PROM: {
		SYNC_AVAILABILITY: {
			summary: 'Sync product availability and price from Prom',
			description:
				'SSE stream. For each product variant that has a `prom_id`, fetches the product from the Prom public API and updates `stock` from `presence` / `quantity_in_stock`. For variants that are in stock it also recalculates `price` as the discounted Prom price plus a fixed tiered markup; out-of-stock variants keep their last known price. Emits progress events and a final summary. Admin only.'
		}
	},
	ORDERS: {
		CREATE: {
			summary: 'Create order',
			description:
				'Place a new order. Validates stock for each variant, snapshots prices, and can apply a discount coupon by code. User can be authenticated or guest.'
		},
		MY: {
			summary: 'Get my orders',
			description:
				'Paginated list of orders for the authenticated user with optional filters by order_status and payment_status.'
		},
		MY_BY_ID: {
			summary: 'Get my order by id',
			description:
				'Get full details of a single order that belongs to the authenticated user.'
		},
		GET_ALL: {
			summary: 'Get all orders',
			description:
				'Paginated list of all orders with optional filters by order_status and payment_status. Admin only.'
		},
		GET_BY_ID: {
			summary: 'Get order by id',
			description: 'Get full order details by MongoDB id. Admin only.'
		},
		UPDATE: {
			summary: 'Update order',
			description:
				'Update editable order fields (items, customer, delivery, payment method, comment). Recalculates totals if items are changed. Admin only.'
		},
		UPDATE_ORDER_STATUS: {
			summary: 'Update order status',
			description: 'Change the fulfillment status of an order. Admin only.'
		},
		UPDATE_PAYMENT_STATUS: {
			summary: 'Update payment status',
			description:
				'Change the payment status of an order. Optionally record the payment transaction id. Admin only.'
		},
		SET_TTN: {
			summary: 'Set Nova Post TTN',
			description: 'Attach the Nova Post tracking number (ТТН) to an order. Admin only.'
		},
		GENERATE_INVOICE: {
			summary: 'Generate order invoice PDF',
			description:
				'Generates and returns a PDF invoice for an order. Accepts an optional admin comment. Admin only.'
		},
		SEND_VENDOR_EMAIL: {
			summary: 'Send email to vendor',
			description: 'Sends an email to a vendor regarding an order. Admin only.'
		},
		GENERATE_REPORT: {
			summary: 'Generate orders report',
			description:
				'Generates a PDF report containing invoices for all orders in the given date range with optional status filters. Each order is rendered as a full invoice page. Admin only.'
		}
	},
	PAYMENT_DETAILS: {
		GET_ALL: {
			summary: 'Get all payment details',
			description: 'Get all payment details records'
		},
		GET_BY_ID: {
			summary: 'Get payment details by id',
			description: 'Get a single payment details record by id'
		},
		CREATE: {
			summary: 'Create payment details',
			description: 'Create a new payment details record'
		},
		UPDATE: {
			summary: 'Update payment details',
			description: 'Update an existing payment details record'
		},
		DELETE: {
			summary: 'Delete payment details',
			description: 'Delete a payment details record'
		},
		GET_ACTIVE: {
			summary: 'Get active payment details',
			description: 'Returns the currently active payment details record'
		},
		ACTIVATE: {
			summary: 'Activate payment details',
			description:
				'Sets the given record as active and deactivates all others. Only one record can be active at a time.'
		}
	},
	PAYMENT_PROVIDERS: {
		GET_ALL: {
			summary: 'Get all payment providers',
			description:
				'List online payment provider credentials (LiqPay/MonoPay). Private keys are never returned. Admin only.'
		},
		GET_ACTIVE: {
			summary: 'Get active payment provider',
			description:
				'Public endpoint. Returns the active credential set for a provider (without secrets) or null. Used to gate the checkout payment options.'
		},
		GET_BY_ID: {
			summary: 'Get payment provider by id',
			description: 'Get a single payment provider record (without secrets). Admin only.'
		},
		CREATE: {
			summary: 'Create payment provider',
			description:
				'Create a payment provider credential set. The private key is encrypted at rest. Admin only.'
		},
		UPDATE: {
			summary: 'Update payment provider',
			description:
				'Update a payment provider. Provide private_key only when rotating it. Admin only.'
		},
		DELETE: {
			summary: 'Delete payment provider',
			description: 'Delete a payment provider credential set. Admin only.'
		},
		ACTIVATE: {
			summary: 'Activate payment provider',
			description:
				'Sets the record active and deactivates other records of the same provider. Admin only.'
		}
	},
	LIQPAY: {
		CHECKOUT: {
			summary: 'Init LiqPay checkout',
			description:
				'Builds the signed LiqPay checkout payload (data + signature) for an existing PENDING order. Public endpoint.'
		},
		CALLBACK: {
			summary: 'LiqPay server callback',
			description:
				'Server-to-server payment callback from LiqPay. Verifies the signature and updates the order payment status. Public endpoint.'
		}
	},
	WHOLESALE_INQUIRIES: {
		CREATE: {
			summary: 'Submit wholesale inquiry',
			description:
				'Submit a wholesale/bulk purchase inquiry form. Public endpoint — no authentication required.'
		},
		GET_ALL: {
			summary: 'Get all wholesale inquiries',
			description:
				'Paginated list of wholesale inquiries with optional status filter. Admin only.'
		},
		UPDATE_STATUS: {
			summary: 'Update wholesale inquiry status',
			description: 'Update the processing status of a wholesale inquiry. Admin only.'
		}
	},
	DISCOUNT_COUPONS: {
		GET_ALL: {
			summary: 'Get all discount coupons',
			description:
				'Get paginated discount coupons with optional filters by active flag and code search query. Admin only.'
		},
		GET_BY_ID: {
			summary: 'Get discount coupon by id',
			description: 'Get discount coupon details by MongoDB id. Admin only.'
		},
		CREATE: {
			summary: 'Create discount coupon',
			description:
				'Create a discount coupon with internal number in DIS-0000123 format and random 10-character code (A-Z, 0-9). Admin only.'
		},
		VALIDATE: {
			summary: 'Validate discount coupon',
			description:
				'Validate coupon code for checkout. Returns validity, and for valid coupons returns discount details.'
		},
		UPDATE: {
			summary: 'Update discount coupon',
			description:
				'Update discount coupon fields (discount percent, expiration, active flag). Admin only.'
		},
		DELETE: {
			summary: 'Delete discount coupon',
			description: 'Delete discount coupon by id. Admin only.'
		}
	}
} as const
