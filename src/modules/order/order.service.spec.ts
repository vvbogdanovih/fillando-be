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
import {
	LIQPAY_SESSION_COOLDOWN_MS,
	liqpayRetryAfterSeconds
} from './helpers/liqpay-session.helpers'
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
			{
				_id: 'order-object-id',
				payment_method: PaymentMethod.IBAN,
				order_status: OrderStatus.CANCELLED,
				payment_status: PaymentStatus.VOIDED
			},
			expect.objectContaining({
				$set: { payment_status: PaymentStatus.PAID, payment_transaction_id: 'txn-42' },
				$push: {
					status_history: {
						$each: [
							expect.objectContaining({
								field: 'payment_status',
								from: PaymentStatus.VOIDED,
								to: PaymentStatus.PAID,
								actor: 'gateway'
							})
						]
					}
				}
			})
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

describe('OrderService — admin status writes (TD-0011)', () => {
	const ORDER_ID = '64b8f0000000000000000000'
	const ADMIN_ID = '64b8f00000000000000000aa'

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

	const pushed = (update: UpdateMock) =>
		(update.mock.calls[0][1] as unknown as { $push?: { status_history: { $each: unknown[] } } })
			.$push?.status_history.$each

	describe('updateOrderStatus', () => {
		it('voids the payment of a cancelled unpaid order and records both changes', async () => {
			const order = buildOrder({
				order_status: OrderStatus.NEW,
				payment_status: PaymentStatus.PENDING
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updateOrderStatus(
				ORDER_ID,
				{ order_status: OrderStatus.CANCELLED },
				ADMIN_ID
			)

			expect(update).toHaveBeenCalledWith(
				{
					_id: 'order-object-id',
					order_status: OrderStatus.NEW,
					payment_status: PaymentStatus.PENDING
				},
				expect.objectContaining({
					$set: {
						order_status: OrderStatus.CANCELLED,
						payment_status: PaymentStatus.VOIDED
					}
				})
			)
			expect(pushed(update)).toEqual([
				expect.objectContaining({
					field: 'order_status',
					from: OrderStatus.NEW,
					to: OrderStatus.CANCELLED,
					actor: 'admin',
					admin_id: new Types.ObjectId(ADMIN_ID)
				}),
				expect.objectContaining({
					field: 'payment_status',
					from: PaymentStatus.PENDING,
					to: PaymentStatus.VOIDED,
					actor: 'admin'
				})
			])
		})

		it('does not touch the payment of a cancelled paid order', async () => {
			const order = buildOrder({
				order_status: OrderStatus.CONFIRMED,
				payment_status: PaymentStatus.PAID
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: OrderStatus.CANCELLED
			})

			expect(update.mock.calls[0][1].$set).toEqual({ order_status: OrderStatus.CANCELLED })
		})

		it('reopens a cancelled order as NEW and expects payment again', async () => {
			const order = buildOrder()
			const update = buildUpdateMock(order)

			await buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: OrderStatus.NEW
			})

			expect(update.mock.calls[0][1].$set).toEqual({
				order_status: OrderStatus.NEW,
				payment_status: PaymentStatus.PENDING
			})
		})

		it('voids the payment of an unpaid parcel that came back', async () => {
			const order = buildOrder({
				order_status: OrderStatus.RETURNING,
				payment_status: PaymentStatus.PENDING,
				payment_method: PaymentMethod.COD,
				delivery_method: DeliveryMethod.NOVA_POST
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: OrderStatus.RETURNED
			})

			expect(update.mock.calls[0][1].$set).toEqual({
				order_status: OrderStatus.RETURNED,
				payment_status: PaymentStatus.VOIDED
			})
		})

		it('completes a paid pickup at handover in the same write', async () => {
			const order = buildOrder({
				order_status: OrderStatus.CONFIRMED,
				payment_status: PaymentStatus.PAID
			})
			const update = buildUpdateMock(order)

			const result = await buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: OrderStatus.DELIVERED
			})

			expect(update.mock.calls[0][1].$set).toEqual({ order_status: OrderStatus.COMPLETED })
			expect(result.allowed_status_transitions).toEqual([OrderStatus.RETURNING])
		})

		it.each([
			[OrderStatus.CANCELLED, OrderStatus.SHIPPED, DeliveryMethod.NOVA_POST],
			[OrderStatus.SHIPPED, OrderStatus.CANCELLED, DeliveryMethod.NOVA_POST],
			[OrderStatus.COMPLETED, OrderStatus.NEW, DeliveryMethod.NOVA_POST],
			[OrderStatus.CONFIRMED, OrderStatus.DELIVERED, DeliveryMethod.NOVA_POST],
			[OrderStatus.RETURNED, OrderStatus.NEW, DeliveryMethod.NOVA_POST]
		])('refuses %s → %s (%s) with 409 and writes nothing', async (from, to, delivery) => {
			const order = buildOrder({ order_status: from, delivery_method: delivery })
			const update = buildUpdateMock(order)

			const call = buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: to
			})

			await expect(call).rejects.toBeInstanceOf(ConflictException)
			await expect(call).rejects.toMatchObject({
				response: { code: 'INVALID_STATUS_TRANSITION', from, to }
			})
			expect(update).not.toHaveBeenCalled()
		})

		it('re-applying CANCELLED still voids a legacy cancelled order that reads PENDING (TD-0003)', async () => {
			const order = buildOrder({
				order_status: OrderStatus.CANCELLED,
				payment_status: PaymentStatus.PENDING
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: OrderStatus.CANCELLED
			})

			expect(update.mock.calls[0][1].$set).toEqual({ payment_status: PaymentStatus.VOIDED })
		})

		it('treats the current status as a no-op', async () => {
			const order = buildOrder({ order_status: OrderStatus.CONFIRMED })
			const update = buildUpdateMock(order)

			await buildService(order, update).updateOrderStatus(ORDER_ID, {
				order_status: OrderStatus.CONFIRMED
			})

			expect(update).not.toHaveBeenCalled()
		})

		it('answers 409 ORDER_STATUS_CHANGED when another write landed first', async () => {
			const order = buildOrder({ order_status: OrderStatus.NEW })
			const update = jest.fn().mockResolvedValue(null) as unknown as UpdateMock

			await expect(
				buildService(order, update).updateOrderStatus(ORDER_ID, {
					order_status: OrderStatus.CONFIRMED
				})
			).rejects.toMatchObject({ response: { code: 'ORDER_STATUS_CHANGED' } })
		})
	})

	describe('updatePaymentStatus', () => {
		it('completes a delivered order the moment it is marked paid', async () => {
			const order = buildOrder({
				order_status: OrderStatus.DELIVERED,
				payment_status: PaymentStatus.PENDING,
				payment_method: PaymentMethod.COD,
				delivery_method: DeliveryMethod.NOVA_POST
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updatePaymentStatus(
				ORDER_ID,
				{ payment_status: PaymentStatus.PAID },
				ADMIN_ID
			)

			expect(update.mock.calls[0][1].$set).toEqual({
				order_status: OrderStatus.COMPLETED,
				payment_status: PaymentStatus.PAID
			})
			expect(pushed(update)).toHaveLength(2)
		})

		it('takes a completed order back to DELIVERED when PAID is undone', async () => {
			const order = buildOrder({
				order_status: OrderStatus.COMPLETED,
				payment_status: PaymentStatus.PAID
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updatePaymentStatus(ORDER_ID, {
				payment_status: PaymentStatus.PENDING
			})

			expect(update.mock.calls[0][1].$set).toEqual({
				order_status: OrderStatus.DELIVERED,
				payment_status: PaymentStatus.PENDING
			})
		})

		it('leaves the order status of an undelivered order alone', async () => {
			const order = buildOrder({
				order_status: OrderStatus.CONFIRMED,
				payment_status: PaymentStatus.PENDING
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).updatePaymentStatus(ORDER_ID, {
				payment_status: PaymentStatus.PAID,
				payment_transaction_id: 'iban-1'
			})

			expect(update.mock.calls[0][1].$set).toEqual({
				payment_transaction_id: 'iban-1',
				payment_status: PaymentStatus.PAID
			})
		})
	})

	describe('setTtn', () => {
		it.each([OrderStatus.NEW, OrderStatus.CONFIRMED, OrderStatus.PROCESSING])(
			'ships a %s Nova Post order and notes the TTN in its history',
			async status => {
				const order = buildOrder({
					order_status: status,
					payment_status: PaymentStatus.PENDING,
					delivery_method: DeliveryMethod.NOVA_POST
				})
				const update = buildUpdateMock(order)

				await buildService(order, update).setTtn(
					ORDER_ID,
					{ nova_post_ttn: '20450081729182' },
					ADMIN_ID
				)

				expect(update.mock.calls[0][1].$set).toEqual({
					nova_post_ttn: '20450081729182',
					nova_post_status: null,
					nova_post_alerted_code: null,
					order_status: OrderStatus.SHIPPED
				})
				expect(pushed(update)).toEqual([
					expect.objectContaining({
						field: 'order_status',
						from: status,
						to: OrderStatus.SHIPPED,
						note: 'ТТН 20450081729182'
					})
				])
			}
		)

		it('ships a courier order too', async () => {
			const order = buildOrder({
				order_status: OrderStatus.CONFIRMED,
				delivery_method: DeliveryMethod.COURIER
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).setTtn(ORDER_ID, { nova_post_ttn: '1' })

			expect(update.mock.calls[0][1].$set.order_status).toBe(OrderStatus.SHIPPED)
		})

		it('only replaces the number on an order that already shipped', async () => {
			const order = buildOrder({
				order_status: OrderStatus.SHIPPED,
				delivery_method: DeliveryMethod.NOVA_POST
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).setTtn(ORDER_ID, { nova_post_ttn: '2' })

			expect(update.mock.calls[0][1]).toEqual({
				$set: { nova_post_ttn: '2', nova_post_status: null, nova_post_alerted_code: null }
			})
		})

		it('ships a pickup order as well — the TTN says it was posted after all', async () => {
			const order = buildOrder({
				order_status: OrderStatus.CONFIRMED,
				delivery_method: DeliveryMethod.PICKUP
			})
			const update = buildUpdateMock(order)

			await buildService(order, update).setTtn(ORDER_ID, { nova_post_ttn: '3' })

			expect(update.mock.calls[0][1].$set.order_status).toBe(OrderStatus.SHIPPED)
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
			order_status: { $in: [OrderStatus.NEW, OrderStatus.PROCESSING, OrderStatus.CONFIRMED] }
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
		['an order that already shipped', { order_status: OrderStatus.SHIPPED }]
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

	it('ignores a failed result for an order that is no longer paid by card — nothing written', async () => {
		const codOrder = order({ payment_method: PaymentMethod.COD })
		const { service, update, emailService } = buildService(codOrder, [])

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, false, 'tx-1')

		expect(update).not.toHaveBeenCalled()
		expect(result.payment_status).toBe(PaymentStatus.PENDING)
		expect(emailService.sendLiqpayPaidAfterMethodChange).not.toHaveBeenCalled()
	})

	it('pins every write on the whole state it read, not only on the method', async () => {
		const liqpay = order({ order_status: OrderStatus.CONFIRMED })
		const { service, update } = buildService(liqpay, [
			{ ...liqpay, payment_status: PaymentStatus.FAILED }
		])

		await service.applyGatewayPaymentResult(ORDER_NUMBER, false)

		expect(filterOf(update, 0)).toEqual({
			_id: 'order-object-id',
			payment_method: PaymentMethod.LIQPAY,
			order_status: OrderStatus.CONFIRMED,
			payment_status: PaymentStatus.PENDING
		})
	})

	it('never stamps COMPLETED over a status that moved under it (TD-0011)', async () => {
		// Read as DELIVERED/PENDING: paying it would close it. Between the read and the write
		// the tracker (or the admin) moved it to RETURNING — the pinned write misses, the fresh
		// state is applied instead, and RETURNING is kept.
		const delivered = order({ order_status: OrderStatus.DELIVERED })
		const returning = { ...delivered, order_status: OrderStatus.RETURNING }
		const paid = { ...returning, payment_status: PaymentStatus.PAID }
		const { service, update, emailService } = buildService(delivered, [null, paid], returning)

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, true, 'tx-1')

		expect(update).toHaveBeenCalledTimes(2)
		expect(setOf(update, 0)).toMatchObject({ order_status: OrderStatus.COMPLETED })
		expect(filterOf(update, 1)).toMatchObject({ order_status: OrderStatus.RETURNING })
		expect(setOf(update, 1)).not.toHaveProperty('order_status')
		expect(setOf(update, 1)).toMatchObject({ payment_status: PaymentStatus.PAID })
		expect(result.order_status).toBe(OrderStatus.RETURNING)
		expect(emailService.sendOrderPaidConfirmation).toHaveBeenCalledTimes(1)
	})

	it('gives up after a second miss and leaves the order to the next callback', async () => {
		const liqpay = order()
		const moved = { ...liqpay, order_status: OrderStatus.CONFIRMED }
		const { service, update, emailService } = buildService(liqpay, [null, null], moved)

		const result = await service.applyGatewayPaymentResult(ORDER_NUMBER, true)

		expect(update).toHaveBeenCalledTimes(2)
		expect(result.payment_status).toBe(PaymentStatus.PENDING)
		expect(emailService.sendOrderPaidConfirmation).not.toHaveBeenCalled()
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

describe('OrderService.claimLiqpayCheckout — one live session, retries included (TD-0009 §5.4.3)', () => {
	const ORDER_ID = new Types.ObjectId('64b8f0000000000000000009')
	const NOW = Date.parse('2026-09-08T20:00:00Z')

	type Doc = Record<string, unknown>

	/** Just enough of Mongo's filter language to prove the claim really is a conditional write. */
	const matches = (doc: Doc, filter: Doc): boolean =>
		Object.entries(filter).every(([key, condition]) => {
			if (key === '$or') return (condition as Doc[]).some(branch => matches(doc, branch))
			const value = doc[key]
			if (condition instanceof Types.ObjectId) return String(value) === String(condition)
			if (
				condition !== null &&
				typeof condition === 'object' &&
				!(condition instanceof Date)
			) {
				return Object.entries(condition as Doc).every(([op, operand]) => {
					if (op === '$in') return (operand as unknown[]).includes(value)
					if (op === '$ne') return value !== operand
					if (op === '$lt')
						return (
							value instanceof Date && value.getTime() < (operand as Date).getTime()
						)
					throw new Error(`unsupported operator ${op}`)
				})
			}
			if (condition instanceof Date && value instanceof Date)
				return value.getTime() === condition.getTime()
			return value === condition
		})

	/** One document mutated by an atomic findOneAndUpdate, the way Mongo serialises the racers. */
	const buildService = (overrides: Doc = {}) => {
		const doc: Doc = {
			_id: ORDER_ID,
			payment_method: PaymentMethod.LIQPAY,
			payment_status: PaymentStatus.PENDING,
			order_status: OrderStatus.NEW,
			liqpay_checkout_started_at: null,
			...overrides
		}
		/** Enough of the aggregation expression language for the claim's conditional history. */
		const evaluate = (expr: unknown): unknown => {
			if (typeof expr === 'string' && expr.startsWith('$')) return doc[expr.slice(1)]
			if (Array.isArray(expr)) return expr.map(evaluate)
			if (expr instanceof Date || expr instanceof Types.ObjectId) return expr
			if (expr && typeof expr === 'object') {
				const [op, args] = Object.entries(expr as Record<string, unknown>)[0]
				if (op === '$cond') {
					const [test, yes, no] = args as unknown[]
					return evaluate(test) ? evaluate(yes) : evaluate(no)
				}
				if (op === '$eq') {
					const [a, b] = (args as unknown[]).map(evaluate)
					return a === b
				}
				if (op === '$ifNull') {
					const [value, fallback] = args as unknown[]
					return evaluate(value) ?? evaluate(fallback)
				}
				if (op === '$concatArrays')
					return (args as unknown[]).flatMap(part => evaluate(part) as unknown[])
				return expr
			}
			return expr
		}
		const update = jest.fn((filter: unknown, stages: UpdatePayload[]) => {
			if (!matches(doc, filter as Doc)) return Promise.resolve(null)
			// Pipeline semantics: every stage reads the document as it was before the stage.
			const next: Doc = {}
			for (const stage of stages)
				for (const [key, expr] of Object.entries(stage.$set)) next[key] = evaluate(expr)
			Object.assign(doc, next)
			return Promise.resolve(doc)
		})
		const service = new OrderService(
			{ updateWithPipeline: update } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)
		return { service, doc, update }
	}

	it('lets a FAILED payment retry at once — no waiting is introduced', async () => {
		const { service, doc } = buildService({
			payment_status: PaymentStatus.FAILED,
			liqpay_checkout_started_at: new Date(NOW - 60_000)
		})
		// The buyer had nothing to wait for before the claim…
		expect(liqpayRetryAfterSeconds(doc as never, NOW)).toBe(0)

		const claimed = await service.claimLiqpayCheckout(ORDER_ID, NOW)

		expect(claimed).not.toBeNull()
		expect(doc.liqpay_checkout_started_at).toEqual(new Date(NOW))
	})

	it('gives a session to only one of two simultaneous retries after FAILED (I-18)', async () => {
		const { service, doc } = buildService({
			payment_status: PaymentStatus.FAILED,
			liqpay_checkout_started_at: new Date(NOW - 60_000)
		})

		const first = await service.claimLiqpayCheckout(ORDER_ID, NOW)
		const second = await service.claimLiqpayCheckout(ORDER_ID, NOW)

		expect(first).not.toBeNull()
		expect(second).toBeNull()
		// The retry in flight is a pending payment again — that is what closes the second tab out
		expect(doc.payment_status).toBe(PaymentStatus.PENDING)
	})

	it('marks the claimed retry PENDING so the lookup shows the session, not a stale failure', async () => {
		const { service, update, doc } = buildService({
			payment_status: PaymentStatus.FAILED,
			liqpay_checkout_started_at: new Date(NOW - 60_000)
		})

		await service.claimLiqpayCheckout(ORDER_ID, NOW)

		expect(update).toHaveBeenCalledTimes(1)
		expect(doc.payment_status).toBe(PaymentStatus.PENDING)
		expect(doc.liqpay_checkout_started_at).toEqual(new Date(NOW))
		expect(liqpayRetryAfterSeconds(doc as never, NOW)).toBe(15 * 60)
	})

	it('writes the FAILED → PENDING move into the history by the same atomic update (TD-0011 F6)', async () => {
		const { service, doc } = buildService({
			payment_status: PaymentStatus.FAILED,
			liqpay_checkout_started_at: new Date(NOW - 60_000),
			status_history: [{ field: 'payment_status', from: 'PENDING', to: 'FAILED' }]
		})

		await service.claimLiqpayCheckout(ORDER_ID, NOW)

		expect(doc.status_history).toEqual([
			{ field: 'payment_status', from: 'PENDING', to: 'FAILED' },
			{
				field: 'payment_status',
				from: PaymentStatus.FAILED,
				to: PaymentStatus.PENDING,
				at: new Date(NOW),
				actor: 'customer'
			}
		])
	})

	it('adds no history entry when a PENDING session is simply renewed', async () => {
		const { service, doc } = buildService({
			liqpay_checkout_started_at: new Date(NOW - LIQPAY_SESSION_COOLDOWN_MS - 1)
		})

		await service.claimLiqpayCheckout(ORDER_ID, NOW)

		expect(doc.payment_status).toBe(PaymentStatus.PENDING)
		expect(doc.status_history).toEqual([])
	})

	it('still refuses a second session while a PENDING one is inside the cooldown', async () => {
		const { service } = buildService({ liqpay_checkout_started_at: new Date(NOW - 60_000) })

		await expect(service.claimLiqpayCheckout(ORDER_ID, NOW)).resolves.toBeNull()
	})

	it('claims again once the cooldown of a PENDING session has passed', async () => {
		const { service } = buildService({
			liqpay_checkout_started_at: new Date(NOW - LIQPAY_SESSION_COOLDOWN_MS - 1)
		})

		await expect(service.claimLiqpayCheckout(ORDER_ID, NOW)).resolves.not.toBeNull()
	})

	it.each([
		['a cancelled order', { order_status: OrderStatus.CANCELLED }],
		['a paid order', { payment_status: PaymentStatus.PAID }],
		['a voided payment', { payment_status: PaymentStatus.VOIDED }],
		['an order moved to COD', { payment_method: PaymentMethod.COD }]
	])('never claims %s', async (_label, overrides) => {
		const { service, doc } = buildService(overrides)

		await expect(service.claimLiqpayCheckout(ORDER_ID, NOW)).resolves.toBeNull()
		expect(doc.liqpay_checkout_started_at).toBeNull()
	})
})

describe('OrderService.findMyOrderById — the cabinet gets the same retry clock (I-33)', () => {
	const USER_ID = '64b8f0000000000000000010'
	const ORDER_ID = '64b8f0000000000000000020'

	const cardOrder = (overrides: Record<string, unknown> = {}) =>
		buildOrder({
			order_status: OrderStatus.NEW,
			payment_status: PaymentStatus.PENDING,
			payment_method: PaymentMethod.LIQPAY,
			liqpay_checkout_started_at: null,
			...overrides
		})

	const buildService = (order: OrderFixture | null) => {
		const orderRepository = {
			findByIdAndUserId: jest.fn().mockResolvedValue(order),
			findById: jest.fn().mockResolvedValue(order),
			findAllByUserPaginated: jest.fn().mockResolvedValue(order ? [order] : []),
			countDocumentsByUser: jest.fn().mockResolvedValue(order ? 1 : 0)
		}
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

	const readMyOrder = async (order: OrderFixture) =>
		(await buildService(order).service.findMyOrderById(USER_ID, ORDER_ID)) as Record<
			string,
			unknown
		>

	it('reports null when no card session was ever opened — nothing to wait for', async () => {
		const result = await readMyOrder(cardOrder())

		expect(result.liqpay_retry_after_seconds).toBeNull()
		// PENDING + NEW — the same rule the success page reads from the public lookup
		expect(result.can_change_payment_method).toBe(true)
	})

	it('counts down the seconds left of a session opened a minute ago', async () => {
		const result = await readMyOrder(
			cardOrder({ liqpay_checkout_started_at: new Date(Date.now() - 60_000) })
		)

		expect(result.liqpay_retry_after_seconds).toBe(LIQPAY_SESSION_COOLDOWN_MS / 1000 - 60)
	})

	it('reports 0 once the stamp of the previous session has gone stale', async () => {
		const result = await readMyOrder(
			cardOrder({
				liqpay_checkout_started_at: new Date(Date.now() - LIQPAY_SESSION_COOLDOWN_MS - 1000)
			})
		)

		expect(result.liqpay_retry_after_seconds).toBe(0)
	})

	it('lets a declined card be retried at once: 0, not the rest of the window', async () => {
		const result = await readMyOrder(
			cardOrder({
				payment_status: PaymentStatus.FAILED,
				liqpay_checkout_started_at: new Date(Date.now() - 60_000)
			})
		)

		expect(result.liqpay_retry_after_seconds).toBe(0)
		expect(result.can_change_payment_method).toBe(true)
	})

	it('agrees with the helper the public lookup uses instead of computing its own number', async () => {
		const order = cardOrder({ liqpay_checkout_started_at: new Date(Date.now() - 120_000) })

		const result = await readMyOrder(order)

		expect(result.liqpay_retry_after_seconds).toBe(liqpayRetryAfterSeconds(order as never))
	})

	it('adds exactly those two fields — nothing else joins the buyer projection', async () => {
		const { service } = buildService(cardOrder())

		const admin = (await service.findById(ORDER_ID)) as Record<string, unknown>
		const mine = (await service.findMyOrderById(USER_ID, ORDER_ID)) as Record<string, unknown>

		expect(Object.keys(mine).filter(key => !(key in admin))).toEqual([
			'can_change_payment_method',
			'liqpay_retry_after_seconds'
		])
	})

	it('carries the clock in the list of my orders too, still without vendor_sku', async () => {
		const { service } = buildService(
			cardOrder({ liqpay_checkout_started_at: new Date(Date.now() - 60_000) })
		)

		const result = (await service.findMyOrders(USER_ID, {})) as {
			items: Array<Record<string, unknown>>
		}

		expect(result.items[0].liqpay_retry_after_seconds).toBe(
			LIQPAY_SESSION_COOLDOWN_MS / 1000 - 60
		)
		expect((result.items[0].items as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
			'vendor_sku'
		)
	})

	it("answers 404 for another user's order — not 403, and not an order without the clock", async () => {
		const { service, orderRepository } = buildService(null)

		await expect(service.findMyOrderById(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
			NotFoundException
		)
		expect(orderRepository.findByIdAndUserId).toHaveBeenCalledTimes(1)
	})
})

describe('OrderService.create — every refusal the buyer can read is Ukrainian and coded (I-15, I-17)', () => {
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

	const buildService = (variants: unknown[] = [buildVariant()], coupon: unknown = null) => {
		const orderRepository = { create: jest.fn() }
		const service = new OrderService(
			orderRepository as never,
			{ increment: jest.fn().mockResolvedValue(123) } as never,
			{ findByIds: jest.fn().mockResolvedValue(variants) } as never,
			{ findActiveByCode: jest.fn().mockResolvedValue(coupon) } as never,
			{} as never,
			{} as never,
			{} as never
		)
		return { service, orderRepository }
	}

	const dto = (overrides: Record<string, unknown> = {}) => ({
		items: [{ variant_id: VARIANT_ID, quantity: 2 }],
		customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' },
		payment_method: PaymentMethod.IBAN,
		delivery_method: DeliveryMethod.PICKUP,
		...overrides
	})

	const refusal = async (service: OrderService, payload: Record<string, unknown>) => {
		const error = (await service.create(payload as never).catch((e: unknown) => e)) as {
			getResponse: () => Record<string, unknown>
		}
		return { error, body: error.getResponse() }
	}

	const isUkrainian = (message: unknown) => /^[^A-Za-z]*[а-яїієґА-ЯЇІЄҐ]/.test(String(message))

	it('answers an unknown variant with 404 VARIANT_NOT_FOUND and the id to highlight', async () => {
		const { service, orderRepository } = buildService([])

		const { error, body } = await refusal(service, dto())

		expect(error).toBeInstanceOf(NotFoundException)
		expect(body).toEqual({
			statusCode: 404,
			error: 'Not Found',
			code: 'VARIANT_NOT_FOUND',
			message:
				'Цього товару вже немає в каталозі — приберіть позицію з кошика, щоб оформити замовлення',
			variant_id: VARIANT_ID
		})
		expect(orderRepository.create).not.toHaveBeenCalled()
	})

	it.each([ProductStatus.DRAFT, ProductStatus.ARCHIVED])(
		'answers a %s variant with 400 VARIANT_UNAVAILABLE in Ukrainian',
		async status => {
			const { service, orderRepository } = buildService([buildVariant({ status })])

			const { error, body } = await refusal(service, dto())

			expect(error).toBeInstanceOf(BadRequestException)
			expect(body).toEqual({
				statusCode: 400,
				error: 'Bad Request',
				code: 'VARIANT_UNAVAILABLE',
				message:
					'Товар знято з продажу (SKU-1) — приберіть позицію з кошика, щоб оформити замовлення',
				variant_id: VARIANT_ID,
				sku: 'SKU-1'
			})
			expect(isUkrainian(body.message)).toBe(true)
			expect(orderRepository.create).not.toHaveBeenCalled()
		}
	)

	it('tells the buyer to remove a sold-out line instead of reducing it below one (I-17)', async () => {
		const { service } = buildService([buildVariant({ stock: 0 })])

		const { error, body } = await refusal(service, dto())

		expect(error).toBeInstanceOf(ConflictException)
		expect(body).toEqual({
			statusCode: 409,
			error: 'Conflict',
			code: 'OUT_OF_STOCK',
			message:
				'Товар закінчився (SKU-1) — приберіть позицію з кошика, щоб оформити замовлення',
			variant_id: VARIANT_ID,
			sku: 'SKU-1',
			available: 0,
			requested: 2
		})
	})

	it('keeps INSUFFICIENT_STOCK and «зменште кількість» while something is left to buy', async () => {
		const { service } = buildService([buildVariant({ stock: 1 })])

		const { body } = await refusal(service, dto())

		expect(body.code).toBe('INSUFFICIENT_STOCK')
		expect(body.message).toBe(
			'Доступно лише 1 шт. (SKU-1) — зменште кількість, щоб оформити замовлення'
		)
	})

	it('names the missing delivery data in Ukrainian instead of the DTO field', async () => {
		const { service } = buildService()

		const { body } = await refusal(service, dto({ delivery_method: DeliveryMethod.NOVA_POST }))

		expect(body).toEqual({
			statusCode: 400,
			error: 'Bad Request',
			code: 'DELIVERY_ADDRESS_REQUIRED',
			message: 'Вкажіть адресу доставки, щоб оформити замовлення'
		})
	})

	it('asks for a Nova Post branch, not for warehouse_description', async () => {
		const { service } = buildService()

		const { body } = await refusal(
			service,
			dto({
				delivery_method: DeliveryMethod.NOVA_POST,
				delivery_address: { city_name: 'Київ' }
			})
		)

		expect(body.code).toBe('NOVA_POST_WAREHOUSE_REQUIRED')
		expect(body.message).toBe('Оберіть відділення Нової Пошти, щоб оформити замовлення')
	})

	it('asks a courier order for the street and the building number', async () => {
		const { service } = buildService()

		const { body } = await refusal(
			service,
			dto({
				delivery_method: DeliveryMethod.COURIER,
				delivery_address: { city_name: 'Київ' }
			})
		)

		expect(body.code).toBe('COURIER_ADDRESS_REQUIRED')
		expect(body.message).toBe("Вкажіть вулицю та номер будинку, щоб кур'єр привіз замовлення")
	})

	it('answers an unknown coupon with COUPON_INVALID and the code as it was normalised', async () => {
		const { service } = buildService()

		const { body } = await refusal(service, dto({ coupon_code: ' spring24 ' }))

		expect(body).toEqual({
			statusCode: 400,
			error: 'Bad Request',
			code: 'COUPON_INVALID',
			message:
				'Купон «SPRING24» не знайдено — перевірте код або оформіть замовлення без купона'
		})
	})

	it('answers an expired coupon with COUPON_EXPIRED', async () => {
		const { service } = buildService([buildVariant()], {
			_id: new Types.ObjectId('64b8f0000000000000000003'),
			code: 'SPRING24',
			discount_percent: 10,
			valid_until: new Date('2020-01-01T00:00:00Z'),
			is_reusable: false
		})

		const { body } = await refusal(service, dto({ coupon_code: 'SPRING24' }))

		expect(body.code).toBe('COUPON_EXPIRED')
		expect(body.message).toBe(
			'Термін дії купона «SPRING24» закінчився — оформіть замовлення без нього'
		)
	})
})

describe('OrderService.findAll — the admin list leaves the history to the detail (TD-0011)', () => {
	it('strips status_history from every row and adds no transitions', async () => {
		const row = buildOrder({
			status_history: [{ field: 'order_status', from: null, to: 'NEW' }]
		})
		const service = new OrderService(
			{
				findAllPaginated: jest.fn().mockResolvedValue([row]),
				countDocuments: jest.fn().mockResolvedValue(1)
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)

		const result = await service.findAll({ page: 1, limit: 20 })

		expect(result.items[0]).not.toHaveProperty('status_history')
		expect(result.items[0]).not.toHaveProperty('allowed_status_transitions')
		expect(result.items[0].order_number).toBe('FO-0000123')
	})
})

describe('OrderService.update — manual discount', () => {
	const ORDER_ID = '64b8f0000000000000000000'
	const VARIANT_ID = '64b8f0000000000000000001'

	const unpaid = (overrides: Record<string, unknown> = {}) =>
		buildOrder({
			order_status: OrderStatus.NEW,
			payment_status: PaymentStatus.PENDING,
			manual_discount: null,
			...overrides
		})

	const buildService = (order: OrderFixture, variants: unknown[] = []) => {
		const update = buildUpdateMock(order)
		const service = new OrderService(
			{ findById: jest.fn().mockResolvedValue(order), update } as never,
			{} as never,
			{ findByIds: jest.fn().mockResolvedValue(variants) } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)
		return { service, update }
	}

	const setOf = (update: UpdateMock) => update.mock.calls[0][1].$set

	it('takes the amount off total_price and stores the reason', async () => {
		const { service, update } = buildService(unpaid())

		await service.update(ORDER_ID, {
			manual_discount: { amount: 50, reason: '  попросив по телефону ' }
		})

		const set = setOf(update)
		expect(set.total_price).toBe(950)
		expect(set.manual_discount).toMatchObject({ amount: 50, reason: 'попросив по телефону' })
		expect(set).not.toHaveProperty('subtotal_price')
	})

	it('stacks on top of the coupon', async () => {
		const { service, update } = buildService(
			unpaid({
				total_price: 900,
				applied_discount: {
					coupon_id: 'c',
					code: 'TEN',
					discount_percent: 10,
					discount_amount: 100
				}
			})
		)

		await service.update(ORDER_ID, { manual_discount: { amount: 50, reason: 'x' } })

		expect(setOf(update).total_price).toBe(850)
	})

	it('removes the discount with null and restores the total', async () => {
		const { service, update } = buildService(
			unpaid({
				total_price: 950,
				manual_discount: { amount: 50, reason: 'x', applied_at: new Date() }
			})
		)

		await service.update(ORDER_ID, { manual_discount: null })

		expect(setOf(update)).toMatchObject({ manual_discount: null, total_price: 1000 })
	})

	it('keeps the discount when the items are edited', async () => {
		const { service, update } = buildService(
			unpaid({
				total_price: 950,
				manual_discount: { amount: 50, reason: 'x', applied_at: new Date() }
			}),
			[
				{
					_id: new Types.ObjectId(VARIANT_ID),
					product_id: new Types.ObjectId(),
					name: 'PLA',
					sku: 'SKU-1',
					price: 500,
					stock: 10,
					status: ProductStatus.ACTIVE
				}
			]
		)

		await service.update(ORDER_ID, { items: [{ variant_id: VARIANT_ID, quantity: 3 }] })

		const set = setOf(update)
		expect(set.subtotal_price).toBe(1500)
		expect(set.total_price).toBe(1450)
		expect(set).not.toHaveProperty('manual_discount')
	})

	it('refuses a discount larger than what is left to pay', async () => {
		const { service, update } = buildService(unpaid())

		await expect(
			service.update(ORDER_ID, { manual_discount: { amount: 1000.01, reason: 'x' } })
		).rejects.toBeInstanceOf(BadRequestException)
		expect(update).not.toHaveBeenCalled()
	})

	it('refuses a blank reason', async () => {
		const { service } = buildService(unpaid())

		await expect(
			service.update(ORDER_ID, { manual_discount: { amount: 50, reason: '   ' } })
		).rejects.toBeInstanceOf(BadRequestException)
	})

	it.each([PaymentStatus.PAID, PaymentStatus.REFUNDED])(
		'refuses once the payment is %s — that is a refund',
		async payment_status => {
			const { service, update } = buildService(unpaid({ payment_status }))

			await expect(
				service.update(ORDER_ID, { manual_discount: { amount: 50, reason: 'x' } })
			).rejects.toBeInstanceOf(ConflictException)
			expect(update).not.toHaveBeenCalled()
		}
	)

	it('refuses while a LiqPay session built with the old amount is open', async () => {
		const { service } = buildService(
			unpaid({
				payment_method: PaymentMethod.LIQPAY,
				liqpay_checkout_started_at: new Date(Date.now() - 60_000)
			})
		)

		await expect(
			service.update(ORDER_ID, { manual_discount: { amount: 50, reason: 'x' } })
		).rejects.toMatchObject({ response: { code: 'LIQPAY_SESSION_ACTIVE' } })
	})

	it('allows it once the LiqPay session has run out', async () => {
		const { service, update } = buildService(
			unpaid({
				payment_method: PaymentMethod.LIQPAY,
				liqpay_checkout_started_at: new Date(Date.now() - LIQPAY_SESSION_COOLDOWN_MS - 1000)
			})
		)

		await service.update(ORDER_ID, { manual_discount: { amount: 50, reason: 'x' } })

		expect(setOf(update).total_price).toBe(950)
	})

	it('hides the reason from the buyer', async () => {
		const order = unpaid({
			user_id: new Types.ObjectId(),
			total_price: 950,
			manual_discount: { amount: 50, reason: 'внутрішнє', applied_at: new Date() },
			liqpay_checkout_started_at: null
		})
		const service = new OrderService(
			{ findByIdAndUserId: jest.fn().mockResolvedValue(order) } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		)

		const result = (await service.findMyOrderById(String(new Types.ObjectId()), ORDER_ID)) as {
			manual_discount: unknown
		}

		expect(result.manual_discount).toEqual({ amount: 50 })
	})
})

describe('OrderService.create — promotions and coupons (TD-0012)', () => {
	const PROMO_ID = '64b8f0000000000000000001'
	const PLAIN_ID = '64b8f0000000000000000002'
	const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

	const variant = (id: string, over: Record<string, unknown> = {}) => ({
		_id: new Types.ObjectId(id),
		product_id: new Types.ObjectId('64b8f0000000000000000009'),
		name: 'PLA',
		sku: `SKU-${id.slice(-1)}`,
		vendor_product_sku: 'V-1',
		price: 500,
		stock: 10,
		status: ProductStatus.ACTIVE,
		images: [],
		promo_percent: null,
		promo_ends_at: null,
		...over
	})
	const onSale = variant(PROMO_ID, { price: 600, promo_percent: 10, promo_ends_at: FUTURE })
	const plain = variant(PLAIN_ID)

	const coupon = { _id: 'c1', code: 'TEN', discount_percent: 10, is_reusable: true }

	const build = (variants: unknown[], withCoupon = false) => {
		const orderRepository = {
			create: jest
				.fn<Promise<unknown>, [Record<string, unknown>]>()
				.mockImplementation(payload => {
					const doc = { _id: 'o1', ...payload }
					return Promise.resolve({ ...doc, toObject: () => doc })
				})
		}
		const discountCouponRepository = {
			findActiveByCode: jest.fn().mockResolvedValue(withCoupon ? coupon : null),
			update: jest.fn().mockResolvedValue(null)
		}
		const service = new OrderService(
			orderRepository as never,
			{ increment: jest.fn().mockResolvedValue(7) } as never,
			{ findByIds: jest.fn().mockResolvedValue(variants) } as never,
			discountCouponRepository as never,
			{ sendOrderIbanConfirmation: jest.fn().mockResolvedValue(undefined) } as never,
			{} as never,
			{} as never
		)
		return { service, orderRepository }
	}

	const dto = (items: Array<{ variant_id: string; quantity: number }>, coupon_code?: string) => ({
		items,
		customer: { name: 'Тест', phone: '+380000000000', email: 'buyer@example.com' },
		payment_method: PaymentMethod.IBAN,
		delivery_method: DeliveryMethod.PICKUP,
		...(coupon_code ? { coupon_code } : {})
	})

	const created = (orderRepository: {
		create: jest.Mock<Promise<unknown>, [Record<string, unknown>]>
	}) =>
		orderRepository.create.mock.calls[0][0] as unknown as {
			items: Array<Record<string, unknown>>
			subtotal_price: number
			total_price: number
			applied_discount: { discount_amount: number } | null
		}

	it('snapshots the sale price as the line price and keeps the regular one beside it', async () => {
		const { service, orderRepository } = build([onSale, plain])

		await service.create(
			dto([
				{ variant_id: PROMO_ID, quantity: 2 },
				{ variant_id: PLAIN_ID, quantity: 1 }
			])
		)

		const order = created(orderRepository)
		expect(order.items[0]).toMatchObject({ price: 540, list_price: 600, promo_percent: 10 })
		expect(order.items[1]).toMatchObject({ price: 500, list_price: 500, promo_percent: null })
		expect(order.subtotal_price).toBe(1580)
		expect(order.total_price).toBe(1580)
	})

	it('applies the coupon to the lines without a promotion only', async () => {
		const { service, orderRepository } = build([onSale, plain], true)

		await service.create(
			dto(
				[
					{ variant_id: PROMO_ID, quantity: 2 },
					{ variant_id: PLAIN_ID, quantity: 1 }
				],
				'TEN'
			)
		)

		const order = created(orderRepository)
		// 10 % of the plain line (500), not of the whole subtotal (1580).
		expect(order.applied_discount).toMatchObject({ discount_amount: 50 })
		expect(order.total_price).toBe(1530)
	})

	it('refuses a coupon when every line is on promotion, so a single-use code is not burned', async () => {
		const { service, orderRepository } = build([onSale], true)

		await expect(
			service.create(dto([{ variant_id: PROMO_ID, quantity: 1 }], 'TEN'))
		).rejects.toMatchObject({ response: { code: 'COUPON_NOT_APPLICABLE' } })
		expect(orderRepository.create).not.toHaveBeenCalled()
	})

	it('treats an expired promotion as no promotion at all', async () => {
		const expired = variant(PROMO_ID, {
			price: 600,
			promo_percent: 10,
			promo_ends_at: new Date('2020-01-01T00:00:00Z')
		})
		const { service, orderRepository } = build([expired], true)

		await service.create(dto([{ variant_id: PROMO_ID, quantity: 1 }], 'TEN'))

		const order = created(orderRepository)
		expect(order.items[0]).toMatchObject({ price: 600, list_price: 600, promo_percent: null })
		expect(order.applied_discount).toMatchObject({ discount_amount: 60 })
	})
})
