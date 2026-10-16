import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { isNonRevenueOrder, round2, sum } from '../helpers/revenue.helpers'
import { storeDayKey, storeHour } from '../report/report.period'
import { enumerateDays, isoWeekday, type StatsPeriod, type StatsPeriodWindow } from './stats.period'

/** An order as the repository projects it for the dashboard (`findStatsSource`). */
export interface StatsSourceOrder {
	createdAt: Date
	order_status: OrderStatus
	payment_status: PaymentStatus
	payment_method: PaymentMethod
	delivery_method: DeliveryMethod
	total_price: number
	items: {
		/** ObjectId on a lean doc; absent on nothing that exists today, but the type says so. */
		variant_id?: { toString(): string } | null
		product_id?: { toString(): string } | null
		sku: string
		name: string
		price: number
		quantity: number
	}[]
}

export interface StatsTotals {
	orders: number
	cancelled: number
	paid: number
	revenue: number
	avg_order_value: number
	units: number
}

export interface StatsDayRow {
	day: string
	weekday: number
	orders: number
	cancelled: number
	paid: number
	revenue: number
	units: number
}

export interface StatsWeekdayRow {
	weekday: number
	days_in_range: number
	orders: number
	revenue: number
	avg_orders: number
	avg_revenue: number
}

export interface StatsHourRow {
	hour: number
	orders: number
	revenue: number
}

export interface StatsHeatmapCell {
	weekday: number
	hour: number
	orders: number
}

export interface StatsBreakdownRow {
	key: string
	orders: number
	revenue: number
}

export interface StatsProductRow {
	variant_id: string | null
	product_id: string | null
	sku: string
	name: string
	quantity: number
	orders: number
	revenue: number
	avg_price: number
}

export interface StatsPeriodOut {
	date_from: string
	date_to: string
	days: number
}

/** The response of `GET /orders/stats`, snake_case so the controller returns it as is. */
export interface OrderStatsData {
	period: StatsPeriodOut
	previous_period: StatsPeriodOut
	generated_at: string
	totals: StatsTotals
	previous_period_totals: StatsTotals
	by_day: StatsDayRow[]
	by_weekday: StatsWeekdayRow[]
	by_hour: StatsHourRow[]
	heatmap: StatsHeatmapCell[]
	by_payment_method: StatsBreakdownRow[]
	by_delivery_method: StatsBreakdownRow[]
	by_order_status: StatsBreakdownRow[]
	by_payment_status: StatsBreakdownRow[]
	top_products_by_revenue: StatsProductRow[]
	top_products_by_quantity: StatsProductRow[]
}

export const TOP_PRODUCTS_LIMIT = 10
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

/**
 * One order, read once. `cancelled` is the shared «not revenue» rule of the sales report; a
 * cancelled order keeps its place in every count («how many people ordered») but brings no
 * revenue and no units («what was sold»). `paid` is independent of it on purpose: a PAID order
 * that was then cancelled is a refund still owed, and the dashboard should not hide it.
 */
interface Classified {
	order: StatsSourceOrder
	cancelled: boolean
	paid: boolean
	revenue: number
	units: number
	day: string
	weekday: number
	hour: number
}

function classify(order: StatsSourceOrder): Classified {
	const cancelled = isNonRevenueOrder(order)
	const units = order.items.reduce((acc, item) => acc + item.quantity, 0)
	const day = storeDayKey(order.createdAt)

	return {
		order,
		cancelled,
		paid: order.payment_status === PaymentStatus.PAID,
		revenue: cancelled ? 0 : order.total_price,
		units: cancelled ? 0 : units,
		day,
		weekday: isoWeekday(day),
		hour: storeHour(order.createdAt)
	}
}

function periodTotals(rows: Classified[]): StatsTotals {
	const orders = rows.length
	const cancelled = rows.filter(row => row.cancelled).length
	const revenue = sum(rows.map(row => row.revenue))
	const live = orders - cancelled

	return {
		orders,
		cancelled,
		paid: rows.filter(row => row.paid).length,
		revenue,
		avg_order_value: live === 0 ? 0 : round2(revenue / live),
		units: rows.reduce((acc, row) => acc + row.units, 0)
	}
}

/** Every day of the window, so a day with no orders is a zero bar and not a missing one. */
function buildByDay(rows: Classified[], window: StatsPeriodWindow): StatsDayRow[] {
	const buckets = new Map<string, StatsDayRow>(
		enumerateDays(window.dateFrom, window.dateTo).map(day => [
			day,
			{
				day,
				weekday: isoWeekday(day),
				orders: 0,
				cancelled: 0,
				paid: 0,
				revenue: 0,
				units: 0
			}
		])
	)

	for (const row of rows) {
		const bucket = buckets.get(row.day)
		// The repository bounds the query by the same window, so this only guards a caller
		// that hands over orders from outside it.
		if (!bucket) continue
		bucket.orders += 1
		if (row.cancelled) bucket.cancelled += 1
		if (row.paid) bucket.paid += 1
		bucket.revenue += row.revenue
		bucket.units += row.units
	}

	return [...buckets.values()].map(bucket => ({ ...bucket, revenue: round2(bucket.revenue) }))
}

/**
 * Derived from the days, not from the orders: a Monday with no orders still counts as a Monday
 * in `days_in_range`, which is what makes the average honest. The denominator is the number of
 * such weekdays the window contains — 2 in a 14-day window, 4 or 5 in a 30-day one.
 */
function buildByWeekday(byDay: StatsDayRow[]): StatsWeekdayRow[] {
	const buckets = new Map<number, StatsWeekdayRow>(
		WEEKDAYS.map(weekday => [
			weekday,
			{ weekday, days_in_range: 0, orders: 0, revenue: 0, avg_orders: 0, avg_revenue: 0 }
		])
	)

	for (const day of byDay) {
		const bucket = buckets.get(day.weekday)!
		bucket.days_in_range += 1
		bucket.orders += day.orders
		bucket.revenue += day.revenue
	}

	return [...buckets.values()].map(bucket => ({
		...bucket,
		revenue: round2(bucket.revenue),
		avg_orders: bucket.days_in_range === 0 ? 0 : round2(bucket.orders / bucket.days_in_range),
		avg_revenue: bucket.days_in_range === 0 ? 0 : round2(bucket.revenue / bucket.days_in_range)
	}))
}

/** «When do people order» — so cancelled orders count here, they were placed too. */
function buildByHour(rows: Classified[]): StatsHourRow[] {
	const buckets = HOURS.map(hour => ({ hour, orders: 0, revenue: 0 }))

	for (const row of rows) {
		buckets[row.hour].orders += 1
		buckets[row.hour].revenue += row.revenue
	}

	return buckets.map(bucket => ({ ...bucket, revenue: round2(bucket.revenue) }))
}

function buildHeatmap(rows: Classified[]): StatsHeatmapCell[] {
	const cells = WEEKDAYS.flatMap(weekday => HOURS.map(hour => ({ weekday, hour, orders: 0 })))

	for (const row of rows) {
		cells[(row.weekday - 1) * 24 + row.hour].orders += 1
	}

	return cells
}

/**
 * Every value of the dimension is a row, zero or not, so the frontend never has to guess which
 * enum values exist. Busiest first; ties keep the enum's own order.
 */
function buildBreakdown(
	rows: Classified[],
	keys: readonly string[],
	pick: (order: StatsSourceOrder) => string
): StatsBreakdownRow[] {
	const buckets = new Map<string, StatsBreakdownRow>(
		keys.map(key => [key, { key, orders: 0, revenue: 0 }])
	)

	for (const row of rows) {
		const key = pick(row.order)
		const bucket = buckets.get(key) ?? { key, orders: 0, revenue: 0 }
		bucket.orders += 1
		bucket.revenue += row.revenue
		buckets.set(key, bucket)
	}

	return [...buckets.values()]
		.map(bucket => ({ ...bucket, revenue: round2(bucket.revenue) }))
		.sort((a, b) => b.orders - a.orders)
}

/**
 * Line values over the orders that are revenue. Pre-coupon, as the sales report's product table:
 * a coupon is a percent off the whole order, and allocating it per line is the report's job, not
 * a ranking's — so these rows do not add up to `totals.revenue`, and the API doc says so.
 */
function buildTopProducts(rows: Classified[]): {
	byRevenue: StatsProductRow[]
	byQuantity: StatsProductRow[]
} {
	const buckets = new Map<string, StatsProductRow & { orderIds: Set<number> }>()

	rows.forEach((row, orderIndex) => {
		if (row.cancelled) return

		for (const item of row.order.items) {
			const variantId = item.variant_id ? String(item.variant_id) : null
			const key = variantId ?? `sku:${item.sku}`
			const bucket = buckets.get(key) ?? {
				variant_id: variantId,
				product_id: item.product_id ? String(item.product_id) : null,
				sku: item.sku,
				// Rows arrive newest first, so the first name seen is the current one.
				name: item.name,
				quantity: 0,
				orders: 0,
				revenue: 0,
				avg_price: 0,
				orderIds: new Set<number>()
			}
			bucket.quantity += item.quantity
			bucket.revenue += item.price * item.quantity
			bucket.orderIds.add(orderIndex)
			buckets.set(key, bucket)
		}
	})

	const products = [...buckets.values()].map(({ orderIds, ...bucket }) => {
		const revenue = round2(bucket.revenue)
		return {
			...bucket,
			revenue,
			orders: orderIds.size,
			avg_price: bucket.quantity === 0 ? 0 : round2(revenue / bucket.quantity)
		}
	})

	const byName = (a: StatsProductRow, b: StatsProductRow) => a.name.localeCompare(b.name, 'uk')

	return {
		byRevenue: [...products]
			.sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity || byName(a, b))
			.slice(0, TOP_PRODUCTS_LIMIT),
		byQuantity: [...products]
			.sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || byName(a, b))
			.slice(0, TOP_PRODUCTS_LIMIT)
	}
}

const toPeriodOut = (window: StatsPeriodWindow): StatsPeriodOut => ({
	date_from: window.dateFrom,
	date_to: window.dateTo,
	days: window.days
})

/**
 * Turns the orders of a period (and of the one before it) into the dashboard's figures.
 *
 * Pure, like `buildSalesReport`: everything is derived from the two selections and the period,
 * so the unit tests and the page read the same numbers.
 */
export function buildOrderStats(
	current: StatsSourceOrder[],
	previous: StatsSourceOrder[],
	period: StatsPeriod,
	generatedAt: Date = new Date()
): OrderStatsData {
	const rows = current.map(classify)
	const previousRows = previous.map(classify)
	const byDay = buildByDay(rows, period)
	const topProducts = buildTopProducts(rows)

	return {
		period: toPeriodOut(period),
		previous_period: toPeriodOut(period.previous),
		generated_at: generatedAt.toISOString(),
		totals: periodTotals(rows),
		previous_period_totals: periodTotals(previousRows),
		by_day: byDay,
		by_weekday: buildByWeekday(byDay),
		by_hour: buildByHour(rows),
		heatmap: buildHeatmap(rows),
		by_payment_method: buildBreakdown(
			rows,
			Object.values(PaymentMethod),
			o => o.payment_method
		),
		by_delivery_method: buildBreakdown(
			rows,
			Object.values(DeliveryMethod),
			o => o.delivery_method
		),
		by_order_status: buildBreakdown(rows, Object.values(OrderStatus), o => o.order_status),
		by_payment_status: buildBreakdown(
			rows,
			Object.values(PaymentStatus),
			o => o.payment_status
		),
		top_products_by_revenue: topProducts.byRevenue,
		top_products_by_quantity: topProducts.byQuantity
	}
}
