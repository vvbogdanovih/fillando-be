export enum Role {
	USER = 'USER',
	ADMIN = 'ADMIN'
}

export enum AuthMethod {
	EMAIL = 'EMAIL',
	GOOGLE = 'GOOGLE',
	GITHUB = 'GITHUB'
}

export enum ProductStatus {
	DRAFT = 'draft',
	ACTIVE = 'active',
	ARCHIVED = 'archived'
}

export enum PaymentMethod {
	CASH = 'CASH',
	IBAN = 'IBAN',
	LIQPAY = 'LIQPAY',
	MONOPAY = 'MONOPAY'
}

export enum PaymentProvider {
	LIQPAY = 'LIQPAY',
	MONOPAY = 'MONOPAY'
}

export enum PaymentStatus {
	PENDING = 'PENDING',
	PAID = 'PAID',
	FAILED = 'FAILED',
	REFUNDED = 'REFUNDED',
	/** Order was cancelled and no money ever arrived — payment is no longer expected. */
	VOIDED = 'VOIDED'
}

export enum DeliveryMethod {
	NOVA_POST = 'NOVA_POST',
	COURIER = 'COURIER',
	PICKUP = 'PICKUP'
}

export enum NovaPostWarehouseType {
	PARCEL_LOCKER = 'PARCEL_LOCKER',
	POST = 'POST',
	CARGO = 'CARGO'
}

export enum WholesaleInquiryStatus {
	NEW = 'NEW',
	PROCESSED = 'PROCESSED'
}

export enum OrderStatus {
	NEW = 'NEW',
	CONFIRMED = 'CONFIRMED',
	PROCESSING = 'PROCESSING',
	SHIPPED = 'SHIPPED',
	DELIVERED = 'DELIVERED',
	COMPLETED = 'COMPLETED',
	CANCELLED = 'CANCELLED',
	RETURNED = 'RETURNED'
}
