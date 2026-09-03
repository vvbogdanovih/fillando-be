import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { orderAccessToken } from 'src/common/services/crypto.util'
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

describe('OrderService.getPaymentStatusPublic', () => {
	const ORDER_NUMBER = 'FO-0000123'
	const validToken = orderAccessToken(ORDER_NUMBER)

	const liqpayOrder = () =>
		buildOrder({
			order_status: OrderStatus.NEW,
			payment_status: PaymentStatus.PENDING,
			payment_method: PaymentMethod.LIQPAY
		})

	const buildService = (order: OrderFixture | null) => {
		const orderRepository = { findByOrderNumber: jest.fn().mockResolvedValue(order) }
		const service = new OrderService(
			orderRepository as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)
		return { service, orderRepository }
	}

	it('rejects a token issued for another order with 404 and never hits the repository', async () => {
		const { service, orderRepository } = buildService(liqpayOrder())
		const foreignToken = orderAccessToken('FO-0000124')

		await expect(
			service.getPaymentStatusPublic(ORDER_NUMBER, foreignToken)
		).rejects.toBeInstanceOf(NotFoundException)
		expect(orderRepository.findByOrderNumber).not.toHaveBeenCalled()
	})

	it('rejects malformed tokens the same way', async () => {
		const { service, orderRepository } = buildService(liqpayOrder())

		for (const token of [
			'',
			'Z'.repeat(32),
			validToken.slice(0, 31),
			validToken.toUpperCase()
		]) {
			await expect(
				service.getPaymentStatusPublic(ORDER_NUMBER, token)
			).rejects.toBeInstanceOf(NotFoundException)
		}
		expect(orderRepository.findByOrderNumber).not.toHaveBeenCalled()
	})

	it('returns exactly the four payment fields for the right token', async () => {
		const { service, orderRepository } = buildService(liqpayOrder())

		const result = await service.getPaymentStatusPublic(ORDER_NUMBER, validToken)

		expect(orderRepository.findByOrderNumber).toHaveBeenCalledWith(ORDER_NUMBER)
		expect(Object.keys(result).sort()).toEqual([
			'order_number',
			'payment_method',
			'payment_status',
			'total_price'
		])
		expect(result).toEqual({
			order_number: 'FO-0000123',
			payment_method: PaymentMethod.LIQPAY,
			payment_status: PaymentStatus.PENDING,
			total_price: 1000
		})
	})

	it('throws 404 for the right token when the order does not exist', async () => {
		const { service, orderRepository } = buildService(null)

		await expect(
			service.getPaymentStatusPublic(ORDER_NUMBER, validToken)
		).rejects.toBeInstanceOf(NotFoundException)
		expect(orderRepository.findByOrderNumber).toHaveBeenCalledTimes(1)
	})

	it('uses an identical message for a wrong token and a missing order (no probing)', async () => {
		const wrongToken = (await buildService(liqpayOrder())
			.service.getPaymentStatusPublic(ORDER_NUMBER, orderAccessToken('FO-0000124'))
			.catch((e: unknown) => e)) as Error
		const missingOrder = (await buildService(null)
			.service.getPaymentStatusPublic(ORDER_NUMBER, validToken)
			.catch((e: unknown) => e)) as Error

		expect(wrongToken).toBeInstanceOf(NotFoundException)
		expect(missingOrder).toBeInstanceOf(NotFoundException)
		expect(wrongToken.message).toBe(missingOrder.message)
	})
})

describe('OrderService.create — payment_access_token', () => {
	const VARIANT_ID = '64b8f0000000000000000001'

	const buildVariant = () => ({
		_id: new Types.ObjectId(VARIANT_ID),
		product_id: new Types.ObjectId('64b8f0000000000000000002'),
		name: 'PLA 1.75 чорний',
		sku: 'SKU-1',
		vendor_product_sku: 'V-1',
		price: 500,
		stock: 10,
		images: []
	})

	const buildService = () => {
		// Mimic a Mongoose document: the persisted fields plus toObject().
		const orderRepository = {
			create: jest.fn().mockImplementation((payload: Record<string, unknown>) => {
				const doc = {
					_id: 'order-object-id',
					order_status: OrderStatus.NEW,
					payment_status: PaymentStatus.PENDING,
					...payload
				}
				return Promise.resolve({ ...doc, toObject: () => doc })
			})
		}
		const numbersRepository = { increment: jest.fn().mockResolvedValue(123) }
		const productVariantRepository = {
			findByIds: jest.fn().mockResolvedValue([buildVariant()])
		}
		const emailService = {
			sendOrderIbanConfirmation: jest.fn().mockResolvedValue(undefined),
			sendOrderCashConfirmation: jest.fn().mockResolvedValue(undefined),
			sendOrderCodConfirmation: jest.fn().mockResolvedValue(undefined)
		}
		const service = new OrderService(
			orderRepository as never,
			numbersRepository as never,
			productVariantRepository as never,
			{} as never,
			emailService as never,
			{} as never,
			{} as never
		)
		return { service, orderRepository, numbersRepository, emailService }
	}

	const baseDto = {
		items: [{ variant_id: VARIANT_ID, quantity: 2 }],
		customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' }
	}

	it('attaches the lookup token to a LIQPAY order without persisting it', async () => {
		const { service, orderRepository, numbersRepository, emailService } = buildService()

		const result = (await service.create({
			...baseDto,
			payment_method: PaymentMethod.LIQPAY,
			delivery_method: DeliveryMethod.PICKUP
		} as never)) as Record<string, unknown>

		expect(numbersRepository.increment).toHaveBeenCalledWith('order')
		expect(result.order_number).toBe('FO-0000123')
		expect(result.payment_method).toBe(PaymentMethod.LIQPAY)
		expect(result.total_price).toBe(1000)
		expect(result.payment_access_token).toBe(orderAccessToken('FO-0000123'))
		// A plain object is returned, not the hydrated document
		expect(result).not.toHaveProperty('toObject')

		// The token is derived, never written to the collection
		expect(orderRepository.create).toHaveBeenCalledTimes(1)
		expect(orderRepository.create.mock.calls[0][0]).not.toHaveProperty('payment_access_token')

		// LiqPay orders still get no confirmation email at creation time
		expect(emailService.sendOrderIbanConfirmation).not.toHaveBeenCalled()
		expect(emailService.sendOrderCashConfirmation).not.toHaveBeenCalled()
		expect(emailService.sendOrderCodConfirmation).not.toHaveBeenCalled()
	})

	it('does not attach the token to a COD order and keeps sending its email', async () => {
		const { service, emailService } = buildService()

		const result = (await service.create({
			...baseDto,
			payment_method: PaymentMethod.COD,
			delivery_method: DeliveryMethod.NOVA_POST,
			delivery_address: {
				city_name: 'Київ',
				warehouse_description: 'Відділення №1',
				warehouse_number: 1
			}
		} as never)) as Record<string, unknown>

		expect(result.order_number).toBe('FO-0000123')
		expect(result.payment_method).toBe(PaymentMethod.COD)
		expect(result).not.toHaveProperty('payment_access_token')
		expect(emailService.sendOrderCodConfirmation).toHaveBeenCalledTimes(1)
		expect(emailService.sendOrderCodConfirmation).toHaveBeenCalledWith(
			'buyer@example.com',
			'FO-0000123',
			expect.any(Object)
		)
	})
})
