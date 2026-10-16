import { Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { buildOrderStats, type StatsSourceOrder, TOP_PRODUCTS_LIMIT } from './stats.builder'
import { resolveStatsPeriod, type StatsPeriod } from './stats.period'

const SEPTEMBER: StatsPeriod = resolveStatsPeriod({
	date_from: '2026-09-01',
	date_to: '2026-09-30'
})

const VARIANT_A = new Types.ObjectId('000000000000000000000a01')
const VARIANT_B = new Types.ObjectId('000000000000000000000b02')
const PRODUCT = new Types.ObjectId('000000000000000000000c03')

function makeOrder(overrides: Partial<StatsSourceOrder> = {}): StatsSourceOrder {
	return {
		createdAt: new Date('2026-09-10T09:00:00.000Z'),
		order_status: OrderStatus.COMPLETED,
		payment_method: PaymentMethod.LIQPAY,
		payment_status: PaymentStatus.PAID,
		delivery_method: DeliveryMethod.NOVA_POST,
		total_price: 1200,
		items: [
			{
				variant_id: VARIANT_A,
				product_id: PRODUCT,
				sku: 'FL-000253',
				name: 'PETG 1кг — Чорний (Black)',
				price: 600,
				quantity: 2
			}
		],
		...overrides
	}
}

const stats = (
	current: StatsSourceOrder[],
	previous: StatsSourceOrder[] = [],
	period = SEPTEMBER
) => buildOrderStats(current, previous, period, new Date('2026-10-16T09:00:00.000Z'))

describe('buildOrderStats — shape with no orders at all', () => {
	const empty = stats([])

	it('still fills every day, weekday, hour and heatmap cell with zeros', () => {
		expect(empty.by_day).toHaveLength(30)
		expect(empty.by_day[0]).toEqual({
			day: '2026-09-01',
			weekday: 2,
			orders: 0,
			cancelled: 0,
			paid: 0,
			revenue: 0,
			units: 0
		})
		expect(empty.by_weekday.map(row => row.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7])
		expect(empty.by_hour).toHaveLength(24)
		expect(empty.heatmap).toHaveLength(168)
		expect(empty.heatmap[0]).toEqual({ weekday: 1, hour: 0, orders: 0 })
		expect(empty.heatmap[167]).toEqual({ weekday: 7, hour: 23, orders: 0 })
	})

	it('lists every enum value of each breakdown', () => {
		expect(empty.by_payment_method.map(row => row.key).sort()).toEqual(
			Object.values(PaymentMethod).sort()
		)
		expect(empty.by_delivery_method.map(row => row.key).sort()).toEqual(
			Object.values(DeliveryMethod).sort()
		)
		expect(empty.by_order_status.map(row => row.key).sort()).toEqual(
			Object.values(OrderStatus).sort()
		)
		expect(empty.by_payment_status.map(row => row.key).sort()).toEqual(
			Object.values(PaymentStatus).sort()
		)
	})

	it('answers zeros, never NaN, in the totals and the averages', () => {
		expect(empty.totals).toEqual({
			orders: 0,
			cancelled: 0,
			paid: 0,
			revenue: 0,
			avg_order_value: 0,
			units: 0
		})
		expect(empty.by_weekday.every(row => row.avg_orders === 0 && row.avg_revenue === 0)).toBe(
			true
		)
		expect(empty.top_products_by_revenue).toEqual([])
	})

	it('echoes both periods and the generation instant', () => {
		expect(empty.period).toEqual({ date_from: '2026-09-01', date_to: '2026-09-30', days: 30 })
		expect(empty.previous_period).toEqual({
			date_from: '2026-08-02',
			date_to: '2026-08-31',
			days: 30
		})
		expect(empty.generated_at).toBe('2026-10-16T09:00:00.000Z')
	})
})

describe('buildOrderStats — which day an order lands on', () => {
	it('buckets by the Kyiv day: 21:30 UTC on 31 August is 1 September', () => {
		const result = stats([makeOrder({ createdAt: new Date('2026-08-31T21:30:00.000Z') })])

		expect(result.by_day[0]).toMatchObject({ day: '2026-09-01', orders: 1, revenue: 1200 })
		expect(result.totals.orders).toBe(1)
	})

	it('keeps the three instants of the 25-hour day together and reads their Kyiv hours', () => {
		const period = resolveStatsPeriod({ date_from: '2026-10-24', date_to: '2026-10-26' })
		const result = buildOrderStats(
			[
				makeOrder({ createdAt: new Date('2026-10-25T00:30:00.000Z') }), // 03:30 EEST
				makeOrder({ createdAt: new Date('2026-10-25T01:30:00.000Z') }), // 03:30 EET, again
				makeOrder({ createdAt: new Date('2026-10-25T21:30:00.000Z') }) // 23:30 EET
			],
			[],
			period
		)

		expect(result.by_day).toHaveLength(3)
		expect(result.by_day[1]).toMatchObject({ day: '2026-10-25', weekday: 7, orders: 3 })
		expect(result.by_hour[3].orders).toBe(2)
		expect(result.by_hour[23].orders).toBe(1)
		expect(result.heatmap.find(c => c.weekday === 7 && c.hour === 3)?.orders).toBe(2)
	})

	it('ignores an order outside the window instead of inventing a day for it', () => {
		const result = stats([makeOrder({ createdAt: new Date('2026-10-05T09:00:00.000Z') })])

		expect(result.by_day).toHaveLength(30)
		expect(result.by_day.every(day => day.orders === 0)).toBe(true)
	})
})

describe('buildOrderStats — cancelled orders are placed but not revenue', () => {
	it.each([
		['order CANCELLED', { order_status: OrderStatus.CANCELLED }],
		['order RETURNING', { order_status: OrderStatus.RETURNING }],
		['order RETURNED', { order_status: OrderStatus.RETURNED }],
		['payment VOIDED', { payment_status: PaymentStatus.VOIDED }],
		['payment REFUNDED', { payment_status: PaymentStatus.REFUNDED }]
	])('%s: counts in orders and cancelled, adds no revenue and no units', (_label, over) => {
		const result = stats([
			makeOrder(),
			makeOrder({ ...over, createdAt: new Date('2026-09-10T10:00:00.000Z') })
		])

		expect(result.totals).toMatchObject({ orders: 2, cancelled: 1, revenue: 1200, units: 2 })
		expect(result.by_day[9]).toMatchObject({ orders: 2, cancelled: 1, revenue: 1200, units: 2 })
	})

	it('keeps a PAID order that was cancelled in both paid and cancelled — a refund is still owed', () => {
		const result = stats([
			makeOrder({ order_status: OrderStatus.CANCELLED, payment_status: PaymentStatus.PAID })
		])

		expect(result.totals).toMatchObject({ orders: 1, cancelled: 1, paid: 1, revenue: 0 })
	})

	it('counts paid as PAID only', () => {
		const result = stats([
			makeOrder({ payment_status: PaymentStatus.PENDING }),
			makeOrder({ payment_status: PaymentStatus.FAILED }),
			makeOrder()
		])

		expect(result.totals.paid).toBe(1)
	})

	it('averages the order value over the orders that are revenue', () => {
		const result = stats([
			makeOrder({ total_price: 1000 }),
			makeOrder({ total_price: 2000 }),
			makeOrder({ total_price: 5000, order_status: OrderStatus.CANCELLED })
		])

		expect(result.totals.avg_order_value).toBe(1500)
	})

	it('still counts a cancelled order in the hour and heatmap figures — it was placed', () => {
		const result = stats([makeOrder({ order_status: OrderStatus.CANCELLED })]) // 12:00 Kyiv, Thursday

		expect(result.by_hour[12]).toEqual({ hour: 12, orders: 1, revenue: 0 })
		expect(result.heatmap.find(c => c.weekday === 4 && c.hour === 12)?.orders).toBe(1)
	})
})

describe('buildOrderStats — the weekday profile', () => {
	it('divides by how many such weekdays the window holds, zero days included', () => {
		const twoWeeks = resolveStatsPeriod({ date_from: '2026-09-01', date_to: '2026-09-14' })
		const result = buildOrderStats(
			[
				makeOrder({ createdAt: new Date('2026-09-01T09:00:00.000Z'), total_price: 1000 }), // Tue
				makeOrder({ createdAt: new Date('2026-09-08T09:00:00.000Z'), total_price: 1000 }), // Tue
				makeOrder({ createdAt: new Date('2026-09-08T10:00:00.000Z'), total_price: 1000 }) // Tue
			],
			[],
			twoWeeks
		)

		expect(result.by_weekday.every(row => row.days_in_range === 2)).toBe(true)
		expect(result.by_weekday[1]).toEqual({
			weekday: 2,
			days_in_range: 2,
			orders: 3,
			revenue: 3000,
			avg_orders: 1.5,
			avg_revenue: 1500
		})
		expect(result.by_weekday[0]).toMatchObject({ weekday: 1, orders: 0, avg_orders: 0 })
	})

	it('gives the first weekday of an 8-day window two days and the rest one', () => {
		const eightDays = resolveStatsPeriod({ date_from: '2026-09-01', date_to: '2026-09-08' })
		const result = buildOrderStats([], [], eightDays)

		expect(result.by_weekday.find(row => row.weekday === 2)?.days_in_range).toBe(2)
		expect(result.by_weekday.find(row => row.weekday === 1)?.days_in_range).toBe(1)
	})
})

describe('buildOrderStats — previous period and breakdowns', () => {
	it('computes the previous period totals from the second selection only', () => {
		const result = stats(
			[makeOrder({ total_price: 100 })],
			[
				makeOrder({ createdAt: new Date('2026-08-10T09:00:00.000Z'), total_price: 300 }),
				makeOrder({ createdAt: new Date('2026-08-11T09:00:00.000Z'), total_price: 500 })
			]
		)

		expect(result.totals).toMatchObject({ orders: 1, revenue: 100 })
		expect(result.previous_period_totals).toMatchObject({
			orders: 2,
			revenue: 800,
			avg_order_value: 400
		})
	})

	it('puts the busiest value first and leaves a cancelled order with no revenue in its row', () => {
		const result = stats([
			makeOrder({ payment_method: PaymentMethod.COD, total_price: 100 }),
			makeOrder({ payment_method: PaymentMethod.COD, total_price: 100 }),
			makeOrder({
				payment_method: PaymentMethod.LIQPAY,
				order_status: OrderStatus.CANCELLED,
				total_price: 900
			})
		])

		expect(result.by_payment_method[0]).toEqual({ key: 'COD', orders: 2, revenue: 200 })
		expect(result.by_payment_method[1]).toEqual({ key: 'LIQPAY', orders: 1, revenue: 0 })
		expect(result.by_order_status.find(row => row.key === 'CANCELLED')).toEqual({
			key: 'CANCELLED',
			orders: 1,
			revenue: 0
		})
	})

	it('adds kopiykas without floating-point drift', () => {
		const result = stats([
			makeOrder({ total_price: 0.1 }),
			makeOrder({ total_price: 0.1 }),
			makeOrder({ total_price: 0.1 })
		])

		expect(result.totals.revenue).toBe(0.3)
	})
})

describe('buildOrderStats — top products', () => {
	const itemB = {
		variant_id: VARIANT_B,
		product_id: PRODUCT,
		sku: 'FL-000254',
		name: 'PLA 1кг',
		price: 400,
		quantity: 1
	}

	it('sums a variant across orders and counts the distinct orders it appeared in', () => {
		const result = stats([
			makeOrder(),
			makeOrder({ items: [{ ...makeOrder().items[0], quantity: 3 }, itemB] })
		])

		expect(result.top_products_by_revenue[0]).toEqual({
			variant_id: String(VARIANT_A),
			product_id: String(PRODUCT),
			sku: 'FL-000253',
			name: 'PETG 1кг — Чорний (Black)',
			quantity: 5,
			orders: 2,
			revenue: 3000,
			avg_price: 600
		})
		expect(result.top_products_by_revenue[1]).toMatchObject({ sku: 'FL-000254', orders: 1 })
	})

	it('leaves the lines of a cancelled order out', () => {
		const result = stats([makeOrder({ order_status: OrderStatus.CANCELLED })])

		expect(result.top_products_by_revenue).toEqual([])
		expect(result.top_products_by_quantity).toEqual([])
	})

	it('ranks by revenue and by quantity separately', () => {
		const result = stats([
			makeOrder({ items: [{ ...makeOrder().items[0], price: 1000, quantity: 1 }] }),
			makeOrder({ items: [{ ...itemB, price: 100, quantity: 5 }] })
		])

		expect(result.top_products_by_revenue.map(row => row.sku)).toEqual([
			'FL-000253',
			'FL-000254'
		])
		expect(result.top_products_by_quantity.map(row => row.sku)).toEqual([
			'FL-000254',
			'FL-000253'
		])
	})

	it('stops at the limit', () => {
		const orders = Array.from({ length: TOP_PRODUCTS_LIMIT + 1 }, (_, i) =>
			makeOrder({
				items: [
					{
						variant_id: new Types.ObjectId(),
						product_id: PRODUCT,
						sku: `SKU-${i}`,
						name: `Товар ${i}`,
						price: 100 + i,
						quantity: 1
					}
				]
			})
		)

		expect(stats(orders).top_products_by_revenue).toHaveLength(TOP_PRODUCTS_LIMIT)
	})

	it('takes the name of the newest order and tolerates a line without ids', () => {
		const result = stats([
			makeOrder({ items: [{ ...makeOrder().items[0], name: 'Нова назва' }] }), // first = newest
			makeOrder({
				createdAt: new Date('2026-09-02T09:00:00.000Z'),
				items: [{ ...makeOrder().items[0], name: 'Стара назва' }]
			}),
			makeOrder({
				items: [
					{
						variant_id: null,
						product_id: null,
						sku: 'LEGACY',
						name: 'Без id',
						price: 50,
						quantity: 1
					}
				]
			})
		])

		expect(result.top_products_by_revenue[0].name).toBe('Нова назва')
		expect(result.top_products_by_revenue[1]).toMatchObject({
			variant_id: null,
			product_id: null,
			sku: 'LEGACY'
		})
	})
})
