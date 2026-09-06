import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { orderAccessToken } from 'src/common/services/crypto.util'
import {
	DeliveryMethod,
	OrderStatus,
	PaymentMethod,
	PaymentStatus,
	ProductStatus
} from 'src/common/types/enums'
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
			buildOrder({
				order_status: OrderStatus.NEW,
				payment_status: PaymentStatus.PENDING,
				payment_method: PaymentMethod.LIQPAY
			})
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

	it('returns exactly the public payment fields for the right token — no customer data', async () => {
		const { service, orderRepository } = buildService(liqpayOrder())

		const result = await service.getPaymentStatusPublic(ORDER_NUMBER, validToken)

		expect(orderRepository.findByOrderNumber).toHaveBeenCalledWith(ORDER_NUMBER)
		expect(Object.keys(result).sort()).toEqual([
			'can_change_payment_method',
			'delivery_method',
			'liqpay_retry_after_seconds',
			'order_number',
			'order_status',
			'payment_method',
			'payment_status',
			'total_price'
		])
		expect(result).toEqual({
			order_number: 'FO-0000123',
			payment_method: PaymentMethod.LIQPAY,
			payment_status: PaymentStatus.PENDING,
			total_price: 1000,
			order_status: OrderStatus.NEW,
			delivery_method: DeliveryMethod.PICKUP,
			// PENDING + NEW: the buyer may still switch to an offline method (TD-0009).
			can_change_payment_method: true,
			// No card session was ever opened, so "pay now" needs no waiting.
			liqpay_retry_after_seconds: null
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

	const buildVariant = (overrides: Record<string, unknown> = {}) => ({
		_id: new Types.ObjectId(VARIANT_ID),
		product_id: new Types.ObjectId('64b8f0000000000000000002'),
		name: 'PLA 1.75 чорний',
		sku: 'SKU-1',
		vendor_product_sku: 'V-1',
		price: 500,
		stock: 10,
		status: ProductStatus.ACTIVE,
		images: [],
		...overrides
	})

	const buildService = (variants: unknown[] = [buildVariant()]) => {
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
			findByIds: jest.fn().mockResolvedValue(variants)
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

	it('answers a stock shortfall with a structured 409 the storefront can pin to a line', async () => {
		const { service, orderRepository } = buildService([buildVariant({ stock: 1 })])

		const err = (await service
			.create({
				...baseDto,
				payment_method: PaymentMethod.IBAN,
				delivery_method: DeliveryMethod.PICKUP
			} as never)
			.catch((e: unknown) => e)) as ConflictException

		expect(err).toBeInstanceOf(ConflictException)
		expect(err.getResponse()).toEqual({
			statusCode: 409,
			error: 'Conflict',
			code: 'INSUFFICIENT_STOCK',
			message: 'Доступно лише 1 шт. (SKU-1) — зменште кількість, щоб оформити замовлення',
			variant_id: VARIANT_ID,
			sku: 'SKU-1',
			available: 1,
			requested: 2
		})
		expect(orderRepository.create).not.toHaveBeenCalled()
	})

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

	it('never returns the supplier article (vendor_sku) to the customer', async () => {
		const { service, orderRepository } = buildService()

		const result = (await service.create({
			...baseDto,
			payment_method: PaymentMethod.IBAN,
			delivery_method: DeliveryMethod.PICKUP
		} as never)) as { items: Array<Record<string, unknown>> }

		expect(result.items).toHaveLength(1)
		expect(result.items[0]).not.toHaveProperty('vendor_sku')
		expect(result.items[0]).toMatchObject({ sku: 'SKU-1', line_total: 1000 })
		// …but the snapshot IS persisted for the admin invoice / vendor e-mail
		expect(orderRepository.create.mock.calls[0][0]).toMatchObject({
			items: [expect.objectContaining({ vendor_sku: 'V-1' })]
		})
	})

	it.each([ProductStatus.DRAFT, ProductStatus.ARCHIVED])(
		'refuses to order a %s variant even when the id is known',
		async status => {
			const { service, orderRepository } = buildService([buildVariant({ status })])

			await expect(
				service.create({
					...baseDto,
					payment_method: PaymentMethod.IBAN,
					delivery_method: DeliveryMethod.PICKUP
				} as never)
			).rejects.toBeInstanceOf(BadRequestException)

			expect(orderRepository.create).not.toHaveBeenCalled()
		}
	)
})

describe('OrderService — the buyer changes the payment method (TD-0009 §5.4.1)', () => {
	const ORDER_NUMBER = 'FO-0000123'
	const validToken = orderAccessToken(ORDER_NUMBER)
	const USER_ID = '64b8f0000000000000000010'
	const ORDER_ID = '64b8f0000000000000000020'

	const failedCardOrder = (overrides: Record<string, unknown> = {}) =>
		buildOrder({
			order_status: OrderStatus.NEW,
			payment_status: PaymentStatus.FAILED,
			payment_method: PaymentMethod.LIQPAY,
			delivery_method: DeliveryMethod.NOVA_POST,
			delivery_address: {
				city_name: 'Львів',
				warehouse_description: 'Відділення №1',
				street: null,
				building: null,
				apartment: null
			},
			...overrides
		})

	/**
	 * `update` applies by default; 'miss' makes the pinned write return null, and `fresh` is
	 * what a re-read then finds (defaults to the order as read).
	 */
	const buildService = (
		order: OrderFixture | null,
		options: { update?: 'apply' | 'miss'; fresh?: OrderFixture | null } = {}
	) => {
		const update: UpdateMock =
			options.update === 'miss' || !order
				? jest
						.fn<Promise<OrderFixture>, [unknown, UpdatePayload]>()
						.mockResolvedValue(null as never)
				: buildUpdateMock(order)
		const orderRepository = {
			findByOrderNumber: jest.fn().mockResolvedValue(order),
			findByIdAndUserId: jest.fn().mockResolvedValue(order),
			findById: jest
				.fn()
				.mockResolvedValue(options.fresh === undefined ? order : options.fresh),
			update
		}
		const emailService = {
			sendPaymentMethodChanged: jest.fn().mockResolvedValue(undefined)
		}
		const service = new OrderService(
			orderRepository as never,
			{} as never,
			{} as never,
			{} as never,
			emailService as never,
			{} as never,
			{} as never
		)
		return { service, orderRepository, emailService, update }
	}

	const cod = { payment_method: PaymentMethod.COD as const }

	it('moves a declined card order to COD, sets the payment back to PENDING and mails both sides', async () => {
		const { service, update, emailService } = buildService(failedCardOrder())

		const result = (await service.changePaymentMethodPublic(
			ORDER_NUMBER,
			validToken,
			cod
		)) as Record<string, unknown>

		expect(update).toHaveBeenCalledTimes(1)
		const [filter, payload] = update.mock.calls[0]
		// The write pins everything it read: a callback or a second tab landing in between
		// makes it miss instead of overwriting.
		expect(filter).toMatchObject({
			_id: 'order-object-id',
			payment_method: PaymentMethod.LIQPAY,
			payment_status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
			order_status: { $in: [OrderStatus.NEW, OrderStatus.CONFIRMED] }
		})
		expect(payload.$set).toEqual({
			payment_method: PaymentMethod.COD,
			payment_status: PaymentStatus.PENDING
		})
		expect(result).toMatchObject({
			order_number: ORDER_NUMBER,
			payment_method: PaymentMethod.COD,
			payment_status: PaymentStatus.PENDING,
			can_change_payment_method: true,
			liqpay_retry_after_seconds: null
		})
		expect(result).not.toHaveProperty('customer')
		expect(emailService.sendPaymentMethodChanged).toHaveBeenCalledWith(
			'buyer@example.com',
			ORDER_NUMBER,
			PaymentMethod.COD,
			PaymentMethod.LIQPAY,
			expect.objectContaining({ totalPrice: 1000 })
		)
	})

	it('is a no-op for the method the order already has: nothing written, no mail', async () => {
		const { service, update, emailService } = buildService(
			failedCardOrder({
				payment_method: PaymentMethod.COD,
				payment_status: PaymentStatus.PENDING
			})
		)

		const result = (await service.changePaymentMethodPublic(
			ORDER_NUMBER,
			validToken,
			cod
		)) as Record<string, unknown>

		expect(update).not.toHaveBeenCalled()
		expect(emailService.sendPaymentMethodChanged).not.toHaveBeenCalled()
		expect(result.payment_method).toBe(PaymentMethod.COD)
	})

	it('refuses cash for a parcel with a Ukrainian message: the delivery rule applies here too', async () => {
		const { service, update } = buildService(failedCardOrder())

		const error = await service
			.changePaymentMethodPublic(ORDER_NUMBER, validToken, {
				payment_method: PaymentMethod.CASH as const
			})
			.catch((e: unknown) => e)

		expect(error).toBeInstanceOf(BadRequestException)
		expect((error as BadRequestException).message).toBe(
			'Спосіб оплати «Готівка» доступний лише з доставкою: Самовивіз'
		)
		expect(update).not.toHaveBeenCalled()
	})

	it.each([
		['a paid order', { payment_status: PaymentStatus.PAID }],
		[
			'a voided order',
			{ payment_status: PaymentStatus.VOIDED, order_status: OrderStatus.CANCELLED }
		],
		['an order already in processing', { order_status: OrderStatus.PROCESSING }]
	])('locks %s with a structured 409', async (_label, overrides) => {
		const { service, update } = buildService(failedCardOrder(overrides))

		const error = await service
			.changePaymentMethodPublic(ORDER_NUMBER, validToken, cod)
			.catch((e: unknown) => e)

		expect(error).toBeInstanceOf(ConflictException)
		expect((error as ConflictException).getResponse()).toMatchObject({
			code: 'PAYMENT_METHOD_LOCKED'
		})
		expect(update).not.toHaveBeenCalled()
	})

	it('answers 409 when the state changed under it — the pinned write matched nothing', async () => {
		const { service, emailService } = buildService(failedCardOrder(), {
			update: 'miss',
			fresh: failedCardOrder({ payment_status: PaymentStatus.PAID })
		})

		const error = await service
			.changePaymentMethodPublic(ORDER_NUMBER, validToken, cod)
			.catch((e: unknown) => e)

		expect(error).toBeInstanceOf(ConflictException)
		expect((error as ConflictException).getResponse()).toMatchObject({
			code: 'PAYMENT_METHOD_LOCKED'
		})
		expect(emailService.sendPaymentMethodChanged).not.toHaveBeenCalled()
	})

	it('treats a miss whose re-read already shows the requested method as the no-op (the other tab won)', async () => {
		const { service, emailService } = buildService(failedCardOrder(), {
			update: 'miss',
			fresh: failedCardOrder({
				payment_method: PaymentMethod.COD,
				payment_status: PaymentStatus.PENDING
			})
		})

		const result = (await service.changePaymentMethodPublic(
			ORDER_NUMBER,
			validToken,
			cod
		)) as Record<string, unknown>

		expect(result.payment_method).toBe(PaymentMethod.COD)
		expect(emailService.sendPaymentMethodChanged).not.toHaveBeenCalled()
	})

	it('rejects a wrong token with the same 404 as the lookup and never reads the order', async () => {
		const { service, orderRepository } = buildService(failedCardOrder())

		const error = await service
			.changePaymentMethodPublic(ORDER_NUMBER, orderAccessToken('FO-0000124'), cod)
			.catch((e: unknown) => e)

		expect(error).toBeInstanceOf(NotFoundException)
		expect((error as NotFoundException).message).toBe(`Order ${ORDER_NUMBER} not found`)
		expect(orderRepository.findByOrderNumber).not.toHaveBeenCalled()
	})

	it('serves the signed-in path by ownership and returns the customer order shape', async () => {
		const { service, orderRepository } = buildService(failedCardOrder())

		const result = (await service.changeMyPaymentMethod(USER_ID, ORDER_ID, cod)) as Record<
			string,
			unknown
		>

		expect(orderRepository.findByIdAndUserId).toHaveBeenCalledTimes(1)
		expect(result).toMatchObject({
			order_number: ORDER_NUMBER,
			payment_method: PaymentMethod.COD,
			payment_status: PaymentStatus.PENDING
		})
	})

	it("answers 404 for another user's order", async () => {
		const { service } = buildService(null)

		await expect(service.changeMyPaymentMethod(USER_ID, ORDER_ID, cod)).rejects.toBeInstanceOf(
			NotFoundException
		)
	})

	it('answers 404, not a BSON error, for an id that is not an ObjectId', async () => {
		const { service, orderRepository } = buildService(failedCardOrder())

		await expect(
			service.changeMyPaymentMethod(USER_ID, 'not-an-id', cod)
		).rejects.toBeInstanceOf(NotFoundException)
		expect(orderRepository.findByIdAndUserId).not.toHaveBeenCalled()
	})
})

describe('OrderService — CASH is limited to pickup (TD-0009 §5.2)', () => {
	const buildService = (order: OrderFixture) =>
		new OrderService(
			{
				findById: jest.fn().mockResolvedValue(order),
				update: buildUpdateMock(order)
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)

	it('rejects moving a parcel order to CASH through the admin update', async () => {
		const service = buildService(
			buildOrder({
				payment_method: PaymentMethod.IBAN,
				delivery_method: DeliveryMethod.NOVA_POST
			})
		)

		await expect(
			service.update('64b8f0000000000000000000', {
				payment_method: PaymentMethod.CASH
			})
		).rejects.toBeInstanceOf(BadRequestException)
	})

	it('rejects sending a CASH order by courier', async () => {
		const service = buildService(
			buildOrder({
				payment_method: PaymentMethod.CASH,
				delivery_method: DeliveryMethod.PICKUP
			})
		)

		await expect(
			service.update('64b8f0000000000000000000', {
				delivery_method: DeliveryMethod.COURIER
			})
		).rejects.toBeInstanceOf(BadRequestException)
	})
})

describe('OrderService.applyGatewayPaymentResult — after the buyer switched methods (TD-0009 §5.4.2)', () => {
	const ORDER_NUMBER = 'FO-0000123'

	const order = (overrides: Record<string, unknown> = {}) =>
		buildOrder({
			order_status: OrderStatus.NEW,
			payment_status: PaymentStatus.PENDING,
			payment_method: PaymentMethod.LIQPAY,
			...overrides
		})

	/** `updates` answers the pinned writes in order; `fresh` is what a re-read finds. */
	const buildService = (read: OrderFixture, updates: (OrderFixture | null)[], fresh = read) => {
		const update = jest.fn<Promise<OrderFixture | null>, [unknown, UpdatePayload]>()
		for (const answer of updates) update.mockResolvedValueOnce(answer)
		const emailService = {
			sendOrderPaidConfirmation: jest.fn().mockResolvedValue(undefined),
			sendLiqpayPaidAfterMethodChange: jest.fn().mockResolvedValue(undefined)
		}
		const service = new OrderService(
			{
				findByOrderNumber: jest.fn().mockResolvedValue(read),
				findById: jest.fn().mockResolvedValue(fresh),
				update
			} as never,
			{} as never,
			{} as never,
			{} as never,
			emailService as never,
			{} as never,
			{} as never
		)
		return { service, update, emailService }
	}

	type GatewayUpdateMock = jest.Mock<Promise<OrderFixture | null>, [unknown, UpdatePayload]>
	const filterOf = (update: GatewayUpdateMock, call: number) =>
		update.mock.calls[call][0] as Record<string, unknown>
	const setOf = (update: GatewayUpdateMock, call: number) => update.mock.calls[call][1].$set

	it('pins a failed result on the card method: a switched order is left alone', async () => {
		const codOrder = order({ payment_method: PaymentMethod.COD })
		const { service, update, emailService } = buildService(codOrder, [null])

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, false, 'tx-1')

		expect(filterOf(update, 0)).toMatchObject({
			payment_method: PaymentMethod.LIQPAY,
			payment_status: { $ne: PaymentStatus.PAID }
		})
		expect(result.payment_status).toBe(PaymentStatus.PENDING)
		expect(emailService.sendLiqpayPaidAfterMethodChange).not.toHaveBeenCalled()
	})

	it('marks a still-LiqPay order FAILED through the same pinned write', async () => {
		const liqpay = order()
		const { service, update } = buildService(liqpay, [
			{ ...liqpay, payment_status: PaymentStatus.FAILED }
		])

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, false)

		expect(setOf(update, 0)).toEqual({ payment_status: PaymentStatus.FAILED })
		expect(result.payment_status).toBe(PaymentStatus.FAILED)
	})

	it('records a late card payment on a switched order: PAID, method back to LIQPAY, admin told not to collect COD', async () => {
		const codOrder = order({ payment_method: PaymentMethod.COD })
		const paid = {
			...codOrder,
			payment_status: PaymentStatus.PAID,
			payment_method: PaymentMethod.LIQPAY
		}
		const { service, update, emailService } = buildService(codOrder, [paid])

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, true, 'tx-1')

		expect(update).toHaveBeenCalledTimes(1)
		expect(setOf(update, 0)).toEqual({
			payment_status: PaymentStatus.PAID,
			payment_method: PaymentMethod.LIQPAY,
			payment_transaction_id: 'tx-1'
		})
		expect(result.payment_method).toBe(PaymentMethod.LIQPAY)
		expect(emailService.sendLiqpayPaidAfterMethodChange).toHaveBeenCalledWith(
			'buyer@example.com',
			ORDER_NUMBER,
			PaymentMethod.COD,
			expect.objectContaining({ totalPrice: 1000 }),
			{ inFulfilment: false, ttn: null }
		)
		expect(emailService.sendOrderPaidConfirmation).not.toHaveBeenCalled()
	})

	it('shouts when the payment lands on a switched order that is already shipped', async () => {
		const shipped = order({
			payment_method: PaymentMethod.COD,
			order_status: OrderStatus.SHIPPED,
			nova_post_ttn: '20450000000001'
		})
		const { service, emailService } = buildService(shipped, [
			{ ...shipped, payment_status: PaymentStatus.PAID, payment_method: PaymentMethod.LIQPAY }
		])

		await service.applyGatewayPaymentResult(ORDER_NUMBER, true, 'tx-1')

		expect(emailService.sendLiqpayPaidAfterMethodChange).toHaveBeenCalledWith(
			'buyer@example.com',
			ORDER_NUMBER,
			PaymentMethod.COD,
			expect.anything(),
			{ inFulfilment: true, ttn: '20450000000001' }
		)
	})

	it('catches a switch that happened between its read and its write', async () => {
		// Read as LiqPay; the pinned PAID write misses because a PATCH moved the order to COD.
		const liqpay = order()
		const nowCod = { ...liqpay, payment_method: PaymentMethod.COD }
		const paidBack = {
			...nowCod,
			payment_status: PaymentStatus.PAID,
			payment_method: PaymentMethod.LIQPAY
		}
		const { service, update, emailService } = buildService(liqpay, [null, paidBack], nowCod)

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, true, 'tx-1')

		expect(update).toHaveBeenCalledTimes(2)
		expect(filterOf(update, 0)).toMatchObject({ payment_method: PaymentMethod.LIQPAY })
		expect(setOf(update, 1)).toMatchObject({
			payment_status: PaymentStatus.PAID,
			payment_method: PaymentMethod.LIQPAY
		})
		expect(result.payment_method).toBe(PaymentMethod.LIQPAY)
		expect(emailService.sendLiqpayPaidAfterMethodChange).toHaveBeenCalledTimes(1)
		expect(emailService.sendOrderPaidConfirmation).not.toHaveBeenCalled()
	})

	it('treats a miss whose re-read is already PAID as the duplicate callback it is', async () => {
		const liqpay = order()
		const alreadyPaid = { ...liqpay, payment_status: PaymentStatus.PAID }
		const { service, update, emailService } = buildService(liqpay, [null], alreadyPaid)

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, true, 'tx-1')

		expect(update).toHaveBeenCalledTimes(1)
		expect(result.payment_status).toBe(PaymentStatus.PAID)
		expect(emailService.sendOrderPaidConfirmation).not.toHaveBeenCalled()
		expect(emailService.sendLiqpayPaidAfterMethodChange).not.toHaveBeenCalled()
	})
})
