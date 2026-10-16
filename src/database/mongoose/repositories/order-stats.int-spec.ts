import { Model, Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { buildOrderStats, type StatsSourceOrder } from 'src/modules/order/stats/stats.builder'
import { resolveStatsPeriod } from 'src/modules/order/stats/stats.period'
import { storeDayEnd, storeDayStart } from 'src/modules/order/report/report.period'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Order, OrderSchema } from '../schemas/order.schema'
import { OrderRepository } from './order.repository'

/**
 * The dashboard's source query (`findStatsSource`): the window boundaries are the Kyiv-day
 * instants of `report.period.ts`, inclusive on both ends, and the projection carries exactly what
 * `stats.builder.ts` reads — no customer, no address, no history.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('OrderRepository.findStatsSource (MongoDB integration)', () => {
	let conn: Conn
	let repo: OrderRepository
	let orderModel: Model<Order>

	const orderDoc = (n: number, createdAt: string, overrides: Record<string, unknown> = {}) => ({
		order_number: `FO-${String(n).padStart(7, '0')}`,
		customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' },
		items: [
			{
				variant_id: new Types.ObjectId(),
				product_id: new Types.ObjectId(),
				name: 'PLA — Чорний (Black)',
				sku: `SKU-${n}`,
				price: 500,
				quantity: 1,
				image: 'https://example.com/i.jpg'
			}
		],
		subtotal_price: 500,
		total_price: 500,
		payment_method: PaymentMethod.LIQPAY,
		payment_status: PaymentStatus.PAID,
		delivery_method: DeliveryMethod.NOVA_POST,
		order_status: OrderStatus.COMPLETED,
		status_history: [],
		createdAt: new Date(createdAt),
		updatedAt: new Date(createdAt),
		...overrides
	})

	beforeAll(async () => {
		conn = await connectTestDb('order-stats')
		orderModel = conn.model<Order>(Order.name, OrderSchema)
		await orderModel.init()
		repo = new OrderRepository(orderModel)

		// Raw inserts: the timestamps plugin would otherwise stamp «now» over `createdAt`.
		await orderModel.collection.insertMany([
			orderDoc(1, '2026-08-31T20:59:59.999Z'), // last ms of 31 August, Kyiv
			orderDoc(2, '2026-08-31T21:00:00.000Z'), // first ms of 1 September, Kyiv
			orderDoc(3, '2026-09-15T12:00:00.000Z'),
			orderDoc(4, '2026-09-30T20:59:59.999Z'), // last ms of 30 September, Kyiv
			orderDoc(5, '2026-09-30T21:00:00.000Z') // 1 October, Kyiv
		])
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	it('takes the Kyiv-day boundaries inclusively on both ends', async () => {
		const rows = await repo.findStatsSource(
			storeDayStart('2026-09-01'),
			storeDayEnd('2026-09-30')
		)

		// `order_number` is not in the projection — the SKU is the row's name here.
		expect(rows.map(row => row.items[0].sku).sort()).toEqual(['SKU-2', 'SKU-3', 'SKU-4'])
	})

	it('projects what the builder reads and nothing personal', async () => {
		const [row] = await repo.findStatsSource(
			storeDayStart('2026-09-15'),
			storeDayEnd('2026-09-15')
		)

		expect(row).toMatchObject({
			order_status: OrderStatus.COMPLETED,
			payment_status: PaymentStatus.PAID,
			payment_method: PaymentMethod.LIQPAY,
			delivery_method: DeliveryMethod.NOVA_POST,
			total_price: 500
		})
		expect(row.items[0]).toMatchObject({ sku: 'SKU-3', price: 500, quantity: 1 })
		expect(row.items[0]).not.toHaveProperty('image')
		expect(row).not.toHaveProperty('customer')
		expect(row).not.toHaveProperty('status_history')
	})

	it('declares the createdAt index the range query relies on', async () => {
		const indexes = await orderModel.collection.indexes()

		expect(indexes.map(index => index.name)).toContain('createdAt_-1')
	})

	it('feeds the builder end to end: the three September orders land on their Kyiv days', async () => {
		const period = resolveStatsPeriod({ date_from: '2026-09-01', date_to: '2026-09-30' })
		const rows = await repo.findStatsSource(
			storeDayStart(period.dateFrom),
			storeDayEnd(period.dateTo)
		)

		const result = buildOrderStats(rows as unknown as StatsSourceOrder[], [], period)

		expect(result.totals.orders).toBe(3)
		expect(result.by_day.find(day => day.day === '2026-09-01')?.orders).toBe(1)
		expect(result.by_day.find(day => day.day === '2026-09-30')?.orders).toBe(1)
		expect(result.top_products_by_revenue).toHaveLength(3)
	})
})
