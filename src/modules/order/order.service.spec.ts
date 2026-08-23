import { BadRequestException } from '@nestjs/common'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { OrderService } from './order.service'

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
	_id: 'order-object-id',
	order_number: 'FO-0000123',
	order_status: OrderStatus.CANCELLED,
	payment_status: PaymentStatus.VOIDED,
	customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' },
	items: [
		{
			name: 'PLA 1.75 чорний',
			sku: 'SKU-1',
			vendor_sku: 'V-1',
			price: 500,
			quantity: 2,
			image: null
		}
	],
	subtotal_price: 1000,
	total_price: 1000,
	applied_discount: null,
	payment_method: PaymentMethod.IBAN,
	delivery_method: DeliveryMethod.PICKUP,
	delivery_address: null,
	...overrides
})

type OrderFixture = ReturnType<typeof buildOrder>
type UpdatePayload = { $set: Record<string, unknown> }
type UpdateMock = jest.Mock<Promise<OrderFixture>, [unknown, UpdatePayload]>

const buildUpdateMock = (order: OrderFixture): UpdateMock =>
	jest
		.fn<Promise<OrderFixture>, [unknown, UpdatePayload]>()
		.mockImplementation((_filter, payload) => Promise.resolve({ ...order, ...payload.$set }))

describe('OrderService.applyGatewayPaymentResult — cancelled orders', () => {
	let update: UpdateMock
	let emailService: {
		sendOrderPaidConfirmation: jest.Mock
		sendCancelledOrderPaidNotification: jest.Mock
	}

	const buildService = (order: OrderFixture): OrderService => {
		update = buildUpdateMock(order)
		const orderRepository = {
			findByOrderNumber: jest.fn().mockResolvedValue(order),
			update,
			findById: jest.fn().mockResolvedValue(order)
		}
		emailService = {
			sendOrderPaidConfirmation: jest.fn().mockResolvedValue(undefined),
			sendCancelledOrderPaidNotification: jest.fn().mockResolvedValue(undefined)
		}
		return new OrderService(
			orderRepository as never,
			{} as never,
			{} as never,
			{} as never,
			emailService as never,
			{} as never,
			{} as never
		)
	}

	it('records a successful payment but notifies the admin instead of the customer', async () => {
		const service = buildService(buildOrder())

		const result = await service.applyGatewayPaymentResult('FO-0000123', true, 'txn-42')

		expect(update).toHaveBeenCalledWith(
			{ _id: 'order-object-id' },
			{ $set: { payment_status: PaymentStatus.PAID, payment_transaction_id: 'txn-42' } }
		)
		expect(result?.payment_status).toBe(PaymentStatus.PAID)
		expect(emailService.sendOrderPaidConfirmation).not.toHaveBeenCalled()
		expect(emailService.sendCancelledOrderPaidNotification).toHaveBeenCalledTimes(1)
	})

	it('keeps VOIDED and writes nothing when the payment failed', async () => {
		const service = buildService(buildOrder())

		const result = await service.applyGatewayPaymentResult('FO-0000123', false)

		expect(update).not.toHaveBeenCalled()
		expect(result?.payment_status).toBe(PaymentStatus.VOIDED)
		expect(emailService.sendOrderPaidConfirmation).not.toHaveBeenCalled()
		expect(emailService.sendCancelledOrderPaidNotification).not.toHaveBeenCalled()
	})

	it('still sends the customer confirmation for an order that is not cancelled', async () => {
		const service = buildService(
			buildOrder({ order_status: OrderStatus.NEW, payment_status: PaymentStatus.PENDING })
		)

		await service.applyGatewayPaymentResult('FO-0000123', true, 'txn-7')

		expect(emailService.sendOrderPaidConfirmation).toHaveBeenCalledTimes(1)
		expect(emailService.sendCancelledOrderPaidNotification).not.toHaveBeenCalled()
	})
})

describe('OrderService.updateOrderStatus — payment side effect', () => {
	const ORDER_ID = '64b8f0000000000000000000'

	const buildService = (order: OrderFixture, update: UpdateMock): OrderService =>
		new OrderService(
			{ findById: jest.fn().mockResolvedValue(order), update } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)

	it('voids the payment of a cancelled unpaid order', async () => {
		const order = buildOrder({
			order_status: OrderStatus.NEW,
			payment_status: PaymentStatus.PENDING
		})
		const update = buildUpdateMock(order)

		await buildService(order, update).updateOrderStatus(ORDER_ID, {
			order_status: OrderStatus.CANCELLED
		})

		expect(update).toHaveBeenCalledWith(expect.anything(), {
			$set: {
				order_status: OrderStatus.CANCELLED,
				payment_status: PaymentStatus.VOIDED
			}
		})
	})

	it('does not touch the payment of a cancelled paid order', async () => {
		const order = buildOrder({
			order_status: OrderStatus.SHIPPED,
			payment_status: PaymentStatus.PAID
		})
		const update = buildUpdateMock(order)

		await buildService(order, update).updateOrderStatus(ORDER_ID, {
			order_status: OrderStatus.CANCELLED
		})

		expect(update).toHaveBeenCalledWith(expect.anything(), {
			$set: { order_status: OrderStatus.CANCELLED }
		})
	})

	it('expects payment again when a cancelled order is reopened', async () => {
		const order = buildOrder()
		const update = buildUpdateMock(order)

		await buildService(order, update).updateOrderStatus(ORDER_ID, {
			order_status: OrderStatus.CONFIRMED
		})

		expect(update).toHaveBeenCalledWith(expect.anything(), {
			$set: {
				order_status: OrderStatus.CONFIRMED,
				payment_status: PaymentStatus.PENDING
			}
		})
	})
})

describe('OrderService — COD is limited to Nova Post deliveries', () => {
	const ORDER_ID = '64b8f0000000000000000000'

	const buildService = (order?: OrderFixture): OrderService =>
		new OrderService(
			{
				findById: jest.fn().mockResolvedValue(order),
				update: order ? buildUpdateMock(order) : jest.fn()
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)

	const createDto = (
		delivery_method: DeliveryMethod,
		delivery_address: Record<string, unknown> | undefined
	) => ({
		items: [{ variant_id: '64b8f0000000000000000001', quantity: 1 }],
		customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' },
		payment_method: PaymentMethod.COD,
		delivery_method,
		delivery_address
	})

	it('rejects a COD order with PICKUP delivery', async () => {
		await expect(
			buildService().create(createDto(DeliveryMethod.PICKUP, undefined) as never)
		).rejects.toBeInstanceOf(BadRequestException)
	})

	it('lets a COD order through the combination check for NOVA_POST', async () => {
		// buildOrderItems is reached only when the combination is valid, and it fails
		// on the empty repository mock — which is proof the guard did not fire.
		await expect(
			buildService().create(
				createDto(DeliveryMethod.NOVA_POST, {
					city_name: 'Київ',
					warehouse_description: 'Відділення №1',
					warehouse_number: 1
				}) as never
			)
		).rejects.not.toBeInstanceOf(BadRequestException)
	})

	it('rejects moving an existing COD order to PICKUP', async () => {
		const order = buildOrder({
			payment_method: PaymentMethod.COD,
			delivery_method: DeliveryMethod.NOVA_POST,
			delivery_address: {
				city_name: 'Київ',
				warehouse_description: 'Відділення №1',
				warehouse_number: 1
			}
		})

		await expect(
			buildService(order).update(ORDER_ID, { delivery_method: DeliveryMethod.PICKUP })
		).rejects.toBeInstanceOf(BadRequestException)
	})

	it('rejects switching a PICKUP order to COD', async () => {
		const order = buildOrder()

		await expect(
			buildService(order).update(ORDER_ID, { payment_method: PaymentMethod.COD })
		).rejects.toBeInstanceOf(BadRequestException)
	})

	it('allows COD on a COURIER order', async () => {
		const order = buildOrder({
			delivery_method: DeliveryMethod.COURIER,
			delivery_address: {
				city_name: 'Київ',
				street: 'Хрещатик',
				building: '1',
				apartment: null
			}
		})

		const result = (await buildService(order).update(ORDER_ID, {
			payment_method: PaymentMethod.COD
		})) as { payment_method: PaymentMethod }

		expect(result.payment_method).toBe(PaymentMethod.COD)
	})
})
