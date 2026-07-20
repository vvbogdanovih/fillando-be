/**
 * Swagger/OpenAPI property metadata (example, description, validation hints) for DTO fields.
 * Used with @ApiProperty() in DTOs to keep docs and examples reusable.
 */
export const API_PROPERTY = {
	EMAIL: {
		example: 'johndoe@example.com',
		description: 'User email'
	},
	PASSWORD: {
		example: 'securepassword',
		description: 'User password',
		minLength: 6
	},
	NAME: {
		example: 'John Doe',
		description: 'User full name'
	},
	PHONE: {
		example: '+380991112233',
		description: 'User phone number in E.164 UA format',
		pattern: '^\\+380\\d{9}$'
	},
	PICTURE: {
		example: 'https://cdn.example.com/users/avatar.webp',
		description: 'Public URL of user profile picture'
	},
	SLUG: {
		example: 'my-slug',
		description: 'URL-friendly identifier'
	},
	VENDOR_NAME: {
		example: 'Fillando',
		description: 'Vendor name'
	},
	CATEGORY_NAME: {
		example: 'Electronics',
		description: 'Category name'
	},
	PRODUCT_NAME: {
		example: 'Wireless Headphones',
		description: 'Product name'
	},
	VARIANT_PRICE: {
		example: 999.99,
		description: 'Variant price'
	},
	S3_KEY: {
		example: 'products/abc123/550e8400-e29b-41d4-a716-446655440000.webp',
		description: 'S3 object key identifying the file in the bucket'
	},
	PRESIGNED_URL: {
		example: 'https://bucket.s3.region.amazonaws.com/key?X-Amz-Signature=...',
		description: 'Presigned S3 PUT URL for direct client-side upload (expires in 15 minutes)'
	},
	PUBLIC_URL: {
		example:
			'https://cdn.example.com/products/abc123/550e8400-e29b-41d4-a716-446655440000.webp',
		description: 'Permanent public URL to access the uploaded file'
	},
	UPLOAD_CONTENT_TYPE: {
		example: 'image/webp',
		description: 'MIME type of the file to upload (image/jpeg, image/png, or image/webp)'
	},
	UPLOAD_ENTITY_TYPE: {
		example: 'product',
		description: 'Entity type the file belongs to (product, user, or vendor)'
	},
	UPLOAD_ENTITY_ID: {
		example: '507f1f77bcf86cd799439011',
		description: 'MongoDB ObjectId of the entity the file belongs to'
	},
	CATEGORY_IMAGE: {
		example: 'https://cdn.example.com/categories/abc123/uuid.webp',
		description:
			'Category image URL — either a direct link or the publicUrl returned from the S3 upload flow',
		required: false
	},
	CATEGORY_ORDER: {
		example: 1,
		description: 'Display order of the category in the UI — lower values appear first',
		required: false
	},
	CART_VARIANT_ID: {
		example: '507f1f77bcf86cd799439011',
		description: 'MongoDB ObjectId of the product variant'
	},
	CART_QUANTITY: {
		example: 2,
		description: 'Number of units (minimum 1)',
		minimum: 1
	},
	PAYMENT_LAST_NAME: {
		example: 'Шевченко',
		description: "Recipient's last name"
	},
	PAYMENT_FIRST_NAME: {
		example: 'Тарас',
		description: "Recipient's first name"
	},
	PAYMENT_MIDDLE_NAME: {
		example: 'Григорович',
		description: "Recipient's middle name",
		required: false
	},
	PAYMENT_IBAN: {
		example: 'UA123456789012345678901234567',
		description: 'International Bank Account Number (IBAN)'
	},
	PAYMENT_EDRPOU: {
		example: '12345678',
		description: 'Ukrainian state registry code (ЄДРПОУ)'
	},
	PAYMENT_BANK_NAME: {
		example: 'ПриватБанк',
		description: 'Name of the bank'
	},
	WHOLESALE_NAME: {
		example: 'Іван Петренко',
		description: 'Contact person full name'
	},
	WHOLESALE_PHONE: {
		example: '+380991112233',
		description: 'Contact phone number in E.164 UA format',
		pattern: '^\\+380\\d{9}$'
	},
	WHOLESALE_EMAIL: {
		example: 'ivan@company.com',
		description: 'Contact email address'
	},
	WHOLESALE_QUANTITY: {
		example: '20 кг на місяць',
		description: 'Desired plastic quantity (free-form text)'
	},
	WHOLESALE_COMMENT: {
		example: 'Цікавить PETG та PLA, потрібна відстрочка платежу',
		description: 'Additional comment or details',
		required: false
	}
} as const
