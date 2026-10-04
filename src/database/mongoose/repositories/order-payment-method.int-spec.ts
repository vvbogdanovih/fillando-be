import { Model, Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { Order, OrderSchema } from '../schemas/order.schema'
import { OrderRepository } from './order.repository'
import { OrderService } from 'src/modules/order/order.service'

/**
 * The conditional write behind the customer's payment-method change (TD-0009 §5.4.1): the filter
 * pins the state the service read, so a LiqPay callback that lands in between — flipping the
 * payment to PAID — makes the write miss instead of turning a card-paid order into a COD one.
 * There is no transaction to lean on (standalone MongoDB); the filter is the whole guard.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

describe('OrderRepository.update — pinned payment-method change (MongoDB integration)', () => {
	let conn: Conn
	let repo: OrderRepository
	let orderModel: Model<Order>

	const CHANGEABLE_PAYMENT = [PaymentStatus.PENDING, PaymentStatus.FAILED]
	const CHANGEABLE_ORDER = [OrderStatus.NEW, OrderStatus.CONFIRMED]

	const orderDoc = (n: number, overrides: Record<string, unknown> = {}) => ({
		order_number: `FO-${String(n).padStart(7, '0')}`,
		customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' },
		items: [
			{
				variant_id: new Types.ObjectId(),
				product_id: new Types.ObjectId(),
				name: 'PLA — Чорний (Black)',
				sku: `SKU-${n}`,
				price: 500,
				quantity: 1
			}
		],
		subtotal_price: 500,
		total_price: 500,
		payment_method: PaymentMethod.LIQPAY,
		payment_status: PaymentStatus.FAILED,
		delivery_method: DeliveryMethod.NOVA_POST,
		order_status: OrderStatus.NEW,
		...overrides
	})

	const pinnedChange = (id: Types.ObjectId, target: PaymentMethod) =>
		repo.update(
			{
				_id: id,
				payment_status: { $in: CHANGEABLE_PAYMENT },
				order_status: { $in: CHANGEABLE_ORDER }
			},
			{ $set: { payment_method: target, payment_status: PaymentStatus.PENDING } }
		)

	beforeAll(async () => {
		conn = await connectTestDb('order-payment-method')
		orderModel = conn.model<Order>(Order.name, OrderSchema)
		await orderModel.init()
		repo = new OrderRepository(orderModel)
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	it('applies to a declined card order and returns the new state', async () => {
		const created = await orderModel.create(orderDoc(1))

		const updated = await pinnedChange(created._id, PaymentMethod.COD)

		expect(updated).not.toBeNull()
		expect(updated!.payment_method).toBe(PaymentMethod.COD)
		expect(updated!.payment_status).toBe(PaymentStatus.PENDING)
	})

	it('misses an order the gateway has meanwhile marked PAID, leaving it untouched', async () => {
		const created = await orderModel.create(orderDoc(2, { payment_status: PaymentStatus.PAID }))

		const updated = await pinnedChange(created._id, PaymentMethod.COD)

		expect(updated).toBeNull()
		const stored = await orderModel.findById(created._id).lean()
		expect(stored!.payment_method).toBe(PaymentMethod.LIQPAY)
		expect(stored!.payment_status).toBe(PaymentStatus.PAID)
	})

	it('misses an order that already shipped (a TTN may carry a COD invoice)', async () => {
		const created = await orderModel.create(
			orderDoc(3, {
				payment_status: PaymentStatus.PENDING,
				order_status: OrderStatus.SHIPPED
			})
		)

		expect(await pinnedChange(created._id, PaymentMethod.IBAN)).toBeNull()
	})

	describe('claimLiqpayCheckout — the pipeline update behind the retry claim (TD-0011 F6)', () => {
		const service = () =>
			new OrderService(
				repo,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never
			)

		it('appends the FAILED → PENDING entry to an existing history by one atomic write', async () => {
			const created = await orderModel.create(
				orderDoc(10, {
					status_history: [
						{
							field: 'payment_status',
							from: 'PENDING',
							to: 'FAILED',
							at: new Date('2026-10-01T10:00:00.000Z'),
							actor: 'gateway'
						}
					]
				})
			)
			const now = Date.parse('2026-10-03T12:00:00.000Z')

			const claimed = await service().claimLiqpayCheckout(created._id, now)

			expect(claimed).not.toBeNull()
			expect(claimed!.payment_status).toBe(PaymentStatus.PENDING)
			expect(claimed!.liqpay_checkout_started_at).toEqual(new Date(now))
			expect(claimed!.status_history.map(e => `${e.from}→${e.to}:${e.actor}`)).toEqual([
				'PENDING→FAILED:gateway',
				'FAILED→PENDING:customer'
			])
			expect(claimed!.status_history[1].at).toEqual(new Date(now))
		})

		it('starts a history on a legacy order that has none', async () => {
			const created = await orderModel.create(orderDoc(11))
			await orderModel.updateOne({ _id: created._id }, { $unset: { status_history: '' } })

			const claimed = await service().claimLiqpayCheckout(created._id)

			expect(claimed!.status_history).toHaveLength(1)
			expect(claimed!.status_history[0].to).toBe(PaymentStatus.PENDING)
		})

		it('renews a PENDING session without touching the history', async () => {
			const created = await orderModel.create(
				orderDoc(12, { payment_status: PaymentStatus.PENDING })
			)

			const claimed = await service().claimLiqpayCheckout(created._id)

			expect(claimed).not.toBeNull()
			expect(claimed!.status_history).toEqual([])
		})

		it('refuses a cancelled order outright', async () => {
			const created = await orderModel.create(
				orderDoc(13, { order_status: OrderStatus.CANCELLED })
			)
			expect(await service().claimLiqpayCheckout(created._id)).toBeNull()
		})
	})

	it('stores the LiqPay checkout stamp the cooldown reads, null until the first payload', async () => {
		const created = await orderModel.create(orderDoc(4))
		expect(created.liqpay_checkout_started_at).toBeNull()

		const before = new Date()
		await repo.update(
			{ _id: created._id },
			{ $set: { liqpay_checkout_started_at: new Date() } }
		)

		const stored = await orderModel.findById(created._id).lean()
		expect(stored!.liqpay_checkout_started_at!.getTime()).toBeGreaterThanOrEqual(
			before.getTime() - 5
		)
	})
})
