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
	MONOPAY = 'MONOPAY',
	/** Cash on delivery — paid to the carrier on pickup. Nova Post shipments only. */
	COD = 'COD'
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

export enum PageOrientation {
	PORTRAIT = 'portrait',
	LANDSCAPE = 'landscape'
}

/**
 * Colour families a visitor can filter by (TD-0002 §5.2.2). Deliberately coarse: these are
 * swatch buckets in the catalogue sidebar, not the manufacturer's colour names, which live
 * in `Color.name_en` / `Color.name_uk`.
 */
export enum ColorFamily {
	BLACK = 'black',
	WHITE = 'white',
	GRAY = 'gray',
	RED = 'red',
	ORANGE = 'orange',
	YELLOW = 'yellow',
	GREEN = 'green',
	BLUE = 'blue',
	PURPLE = 'purple',
	PINK = 'pink',
	BROWN = 'brown',
	GOLD = 'gold',
	SILVER = 'silver',
	TRANSPARENT = 'transparent',
	MULTICOLOR = 'multicolor'
}

/**
 * A landing page is only reachable by the public once its copy is written — until then it
 * stays a draft, exactly like an unpublished product (`ProductStatus.DRAFT`).
 */
export enum LandingStatus {
	DRAFT = 'draft',
	ACTIVE = 'active'
}
