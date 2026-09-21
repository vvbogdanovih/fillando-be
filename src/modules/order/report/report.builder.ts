import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { storeDayKey } from './report.period'

/** An order as it comes out of the repository, narrowed to what the report actually reads. */
export interface ReportSourceOrder {
	order_number: string
	createdAt: Date
	order_status: OrderStatus
	payment_method: PaymentMethod
	payment_status: PaymentStatus
	delivery_method: DeliveryMethod
	customer: { name: string; phone: string; email: string }
	items: {
		name: string
		sku: string
		vendor_sku: string | null
		price: number
		quantity: number
	}[]
	subtotal_price: number
	total_price: number
	applied_discount: { code: string; discount_amount: number } | null
}

export interface ReportFilters {
	dateFrom: string
	dateTo: string
	orderStatus: OrderStatus | null
	paymentStatus: PaymentStatus | null
}

/** One SKU, summed across every order in the selection. */
export interface ProductRow {
	sku: string
	vendorSku: string | null
	name: string
	quantity: number
	orders: number
	averagePrice: number
	amount: number
}

/** One order, as the finance register lists it. */
export interface OrderRow {
	orderNumber: string
	createdAt: Date
	customer: string
	positions: number
	units: number
	orderStatus: OrderStatus
	paymentMethod: PaymentMethod
	paymentStatus: PaymentStatus
	deliveryMethod: DeliveryMethod
	subtotal: number
	discount: number
	discountCode: string | null
	total: number
}

/** One slice of the period. The key stays an enum value; the template decides how to label it. */
export interface BreakdownRow<Key extends string = string> {
	key: Key
	orders: number
	amount: number
	share: number
}

export interface DayRow {
	day: string
	orders: number
	units: number
	amount: number
}

export interface ReportTotals {
	orders: number
	positions: number
	units: number
	/** Line value before coupons — the figure the product table sums to. */
	subtotal: number
	discount: number
	/** What the orders were charged at: the only number that should reach the ledger. */
	total: number
	paid: number
	awaiting: number
}

/** Orders in the selection that are not revenue: cancelled, returned or refunded. */
export interface NonRevenueSummary {
	orders: number
	amount: number
}

export interface SalesReportData {
	filters: ReportFilters
	generatedAt: Date
	products: ProductRow[]
	orders: OrderRow[]
	totals: ReportTotals
	byPaymentStatus: BreakdownRow<PaymentStatus>[]
	byPaymentMethod: BreakdownRow<PaymentMethod>[]
	byOrderStatus: BreakdownRow<OrderStatus>[]
	byDeliveryMethod: BreakdownRow<DeliveryMethod>[]
	byDay: DayRow[]
	nonRevenue: NonRevenueSummary
	/**
	 * Set when the stored `subtotal_price` of the selection disagrees with the line values the
	 * product table is summed from. Finance is told rather than shown two totals that silently
	 * fail to reconcile.
	 */
	subtotalMismatch: number | null
}

const NON_REVENUE_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.RETURNED])

function round2(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100
}

function sum(values: number[]): number {
	return round2(values.reduce((acc, value) => acc + value, 0))
}

function toBreakdown<Key extends string>(
	rows: OrderRow[],
	key: (row: OrderRow) => Key
): BreakdownRow<Key>[] {
	const buckets = new Map<Key, { orders: number; amount: number }>()

	for (const row of rows) {
		const bucketKey = key(row)
		const bucket = buckets.get(bucketKey) ?? { orders: 0, amount: 0 }
		bucket.orders += 1
		bucket.amount += row.total
		buckets.set(bucketKey, bucket)
	}

	const total = sum(rows.map(row => row.total))

	return [...buckets.entries()]
		.map(([bucketKey, bucket]) => ({
			key: bucketKey,
			orders: bucket.orders,
			amount: round2(bucket.amount),
			share: total === 0 ? 0 : round2((bucket.amount / total) * 100)
		}))
		.sort((a, b) => b.amount - a.amount)
}

function buildProducts(orders: ReportSourceOrder[]): ProductRow[] {
	const buckets = new Map<
		string,
		{ row: Omit<ProductRow, 'averagePrice' | 'orders'>; orders: Set<string> }
	>()

	for (const order of orders) {
		for (const item of order.items) {
			const bucket = buckets.get(item.sku) ?? {
				// Orders arrive newest first, so the first name seen is the current one.
				row: {
					sku: item.sku,
					vendorSku: item.vendor_sku,
					name: item.name,
					quantity: 0,
					amount: 0
				},
				orders: new Set<string>()
			}

			bucket.row.quantity += item.quantity
			bucket.row.amount += item.price * item.quantity
			bucket.row.vendorSku = bucket.row.vendorSku ?? item.vendor_sku
			bucket.orders.add(order.order_number)
			buckets.set(item.sku, bucket)
		}
	}

	return [...buckets.values()]
		.map(({ row, orders: orderNumbers }) => ({
			...row,
			amount: round2(row.amount),
			orders: orderNumbers.size,
			averagePrice: row.quantity === 0 ? 0 : round2(row.amount / row.quantity)
		}))
		.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'uk'))
}

function buildDays(orders: OrderRow[]): DayRow[] {
	const buckets = new Map<string, DayRow>()

	for (const order of orders) {
		const day = storeDayKey(order.createdAt)
		const bucket = buckets.get(day) ?? { day, orders: 0, units: 0, amount: 0 }
		bucket.orders += 1
		bucket.units += order.units
		bucket.amount += order.total
		buckets.set(day, bucket)
	}

	return [...buckets.values()]
		.map(bucket => ({ ...bucket, amount: round2(bucket.amount) }))
		.sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * Turns the orders of a period into the figures the finance report prints.
 *
 * Pure: every number here is derived from the selection alone, so the template renders and the
 * tests assert against the same values.
 */
export function buildSalesReport(
	sourceOrders: ReportSourceOrder[],
	filters: ReportFilters,
	generatedAt: Date = new Date()
): SalesReportData {
	const orders: OrderRow[] = sourceOrders.map(order => ({
		orderNumber: order.order_number,
		createdAt: order.createdAt,
		customer: order.customer.name,
		positions: order.items.length,
		units: order.items.reduce((acc, item) => acc + item.quantity, 0),
		orderStatus: order.order_status,
		paymentMethod: order.payment_method,
		paymentStatus: order.payment_status,
		deliveryMethod: order.delivery_method,
		subtotal: round2(order.subtotal_price),
		discount: round2(order.applied_discount?.discount_amount ?? 0),
		discountCode: order.applied_discount?.code ?? null,
		total: round2(order.total_price)
	}))

	const products = buildProducts(sourceOrders)

	const subtotal = sum(orders.map(order => order.subtotal))
	const lineValue = sum(products.map(product => product.amount))
	const nonRevenueOrders = orders.filter(
		order =>
			NON_REVENUE_STATUSES.has(order.orderStatus) ||
			order.paymentStatus === PaymentStatus.REFUNDED
	)

	return {
		filters,
		generatedAt,
		products,
		orders,
		totals: {
			orders: orders.length,
			positions: orders.reduce((acc, order) => acc + order.positions, 0),
			units: orders.reduce((acc, order) => acc + order.units, 0),
			subtotal,
			discount: sum(orders.map(order => order.discount)),
			total: sum(orders.map(order => order.total)),
			paid: sum(
				orders
					.filter(order => order.paymentStatus === PaymentStatus.PAID)
					.map(order => order.total)
			),
			awaiting: sum(
				orders
					.filter(order => order.paymentStatus === PaymentStatus.PENDING)
					.map(order => order.total)
			)
		},
		byPaymentStatus: toBreakdown(orders, order => order.paymentStatus),
		byPaymentMethod: toBreakdown(orders, order => order.paymentMethod),
		byOrderStatus: toBreakdown(orders, order => order.orderStatus),
		byDeliveryMethod: toBreakdown(orders, order => order.deliveryMethod),
		byDay: buildDays(orders),
		nonRevenue: {
			orders: nonRevenueOrders.length,
			amount: sum(nonRevenueOrders.map(order => order.total))
		},
		subtotalMismatch:
			Math.abs(lineValue - subtotal) < 0.01 ? null : round2(lineValue - subtotal)
	}
}
