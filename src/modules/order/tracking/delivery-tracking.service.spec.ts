import { Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import type { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import type { EmailService } from 'src/modules/email/email.service'
import { DeliveryTrackingService } from './delivery-tracking.service'
import type { NovaPostTrackingClient, TrackingResult } from './nova-post-tracking.client'

const NOW = new Date('2026-09-29T10:00:00.000Z')

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
	_id: new Types.ObjectId(),
	order_number: 'FL-1',
	order_status: OrderStatus.SHIPPED,
	payment_status: PaymentStatus.PAID,
	payment_method: PaymentMethod.LIQPAY,
	delivery_method: DeliveryMethod.NOVA_POST,
	nova_post_ttn: '20450000000001',
	nova_post_alerted_code: null,
	customer: { name: 'Іван', phone: '+380670000000', email: 'i@example.com' },
	...overrides
})

function setup(orders: ReturnType<typeof makeOrder>[], statuses: Record<string, TrackingResult>) {
	const orderRepository = {
		findTrackable: jest.fn().mockResolvedValue(orders),
		update: jest
			.fn<
				Promise<unknown>,
				[unknown, { $set: Record<string, unknown>; $push?: Record<string, any> }]
			>()
			.mockResolvedValue({})
	}
	const trackingClient = {
		getStatuses: jest.fn().mockResolvedValue(new Map(Object.entries(statuses)))
	}
	const emailService = { sendDeliveryIssueAlert: jest.fn().mockResolvedValue(undefined) }
	const service = new DeliveryTrackingService(
		orderRepository as unknown as OrderRepository,
		trackingClient as unknown as NovaPostTrackingClient,
		emailService as unknown as EmailService
	)
	return { service, orderRepository, trackingClient, emailService }
}

describe('DeliveryTrackingService', () => {
	it('closes a paid order whose parcel was received, guarded on what it read', async () => {
		const order = makeOrder()
		const { service, orderRepository } = setup([order], {
			'20450000000001': { code: '9', text: 'Відправлення отримано' }
		})

		const summary = await service.run(NOW)

		expect(orderRepository.update).toHaveBeenCalledWith(
			{
				_id: order._id,
				order_status: OrderStatus.SHIPPED,
				payment_status: PaymentStatus.PAID,
				nova_post_ttn: '20450000000001'
			},
			{
				$set: {
					order_status: OrderStatus.COMPLETED,
					nova_post_status: { code: '9', text: 'Відправлення отримано', checked_at: NOW }
				},
				$push: {
					status_history: {
						$each: [
							{
								field: 'order_status',
								from: OrderStatus.SHIPPED,
								to: OrderStatus.COMPLETED,
								at: NOW,
								actor: 'tracker',
								note: 'НП 9 «Відправлення отримано»'
							}
						]
					}
				}
			}
		)
		expect(summary).toEqual({ checked: 1, answered: 1, updated: 1, alerted: 0 })
	})

	it('closes a received cash-on-delivery parcel as paid and COMPLETED in one write', async () => {
		const order = makeOrder({
			payment_status: PaymentStatus.PENDING,
			payment_method: PaymentMethod.COD
		})
		const { service, orderRepository } = setup([order], {
			'20450000000001': { code: '10', text: 'Отримано' }
		})

		const summary = await service.run(NOW)

		const payload = orderRepository.update.mock.calls[0][1]
		expect(payload.$set).toMatchObject({
			order_status: OrderStatus.COMPLETED,
			payment_status: PaymentStatus.PAID
		})
		expect(payload.$push?.status_history.$each).toEqual([
			expect.objectContaining({
				field: 'order_status',
				from: OrderStatus.SHIPPED,
				to: OrderStatus.COMPLETED,
				actor: 'tracker'
			}),
			expect.objectContaining({
				field: 'payment_status',
				from: PaymentStatus.PENDING,
				to: PaymentStatus.PAID,
				actor: 'tracker'
			})
		])
		expect(summary.updated).toBe(1)
	})

	it("stops an unpaid non-COD parcel at DELIVERED — that money is not the carrier's to confirm", async () => {
		const { service, orderRepository } = setup(
			[
				makeOrder({
					payment_status: PaymentStatus.PENDING,
					payment_method: PaymentMethod.IBAN
				})
			],
			{ '20450000000001': { code: '10', text: 'Отримано' } }
		)
		await service.run(NOW)
		const set = orderRepository.update.mock.calls[0][1].$set
		expect(set.order_status).toBe(OrderStatus.DELIVERED)
		expect(set).not.toHaveProperty('payment_status')
	})

	it('does not count an update the admin raced with', async () => {
		const { service, orderRepository } = setup([makeOrder()], {
			'20450000000001': { code: '9', text: 'Отримано' }
		})
		orderRepository.update.mockResolvedValue(null)
		expect((await service.run(NOW)).updated).toBe(0)
	})

	it('moves a refused parcel to RETURNING, emails once and remembers it', async () => {
		const order = makeOrder()
		const { service, orderRepository, emailService } = setup([order], {
			'20450000000001': { code: '103', text: 'Відмова одержувача' }
		})

		const summary = await service.run(NOW)

		expect(emailService.sendDeliveryIssueAlert).toHaveBeenCalledWith(
			expect.objectContaining({ orderNumber: 'FL-1', statusCode: '103' })
		)
		const set = orderRepository.update.mock.calls[0][1].$set
		expect(set.order_status).toBe(OrderStatus.RETURNING)
		expect(set.nova_post_alerted_code).toBe('103')
		expect(summary).toMatchObject({ alerted: 1, updated: 1 })
	})

	it('emails a deleted or unknown TTN without touching the status', async () => {
		const { service, orderRepository, emailService } = setup([makeOrder()], {
			'20450000000001': { code: '3', text: 'Номер не знайдено' }
		})

		await service.run(NOW)

		expect(emailService.sendDeliveryIssueAlert).toHaveBeenCalledTimes(1)
		const payload = orderRepository.update.mock.calls[0][1]
		expect(payload.$set).not.toHaveProperty('order_status')
		expect(payload.$set.nova_post_alerted_code).toBe('3')
		expect(payload.$push).toBeUndefined()
	})

	it('still starts the return when the refusal was already emailed', async () => {
		const { service, orderRepository, emailService } = setup(
			[makeOrder({ nova_post_alerted_code: '103' })],
			{ '20450000000001': { code: '103', text: 'Відмова одержувача' } }
		)
		await service.run(NOW)
		expect(emailService.sendDeliveryIssueAlert).not.toHaveBeenCalled()
		expect(orderRepository.update.mock.calls[0][1].$set.order_status).toBe(
			OrderStatus.RETURNING
		)
	})

	it('does not email the same refusal again', async () => {
		const { service, emailService } = setup([makeOrder({ nova_post_alerted_code: '103' })], {
			'20450000000001': { code: '103', text: 'Відмова одержувача' }
		})
		await service.run(NOW)
		expect(emailService.sendDeliveryIssueAlert).not.toHaveBeenCalled()
	})

	it('retries the email next run when sending fails', async () => {
		const { service, orderRepository, emailService } = setup([makeOrder()], {
			'20450000000001': { code: '102', text: 'Відмова' }
		})
		emailService.sendDeliveryIssueAlert.mockRejectedValue(new Error('resend down'))

		const summary = await service.run(NOW)

		// No RETURNING either: that would take the order out of tracking with nobody told.
		expect(orderRepository.update.mock.calls[0][1]).toEqual({
			$set: { nova_post_status: { code: '102', text: 'Відмова', checked_at: NOW } }
		})
		expect(summary.alerted).toBe(0)
	})

	it('only records the status of a parcel still on its way', async () => {
		const { service, orderRepository } = setup([makeOrder()], {
			'20450000000001': { code: '5', text: 'Прямує до міста' }
		})
		await service.run(NOW)
		expect(orderRepository.update.mock.calls[0][1]).toEqual({
			$set: { nova_post_status: { code: '5', text: 'Прямує до міста', checked_at: NOW } }
		})
	})

	it('skips a TTN Nova Post did not answer for', async () => {
		const { service, orderRepository } = setup([makeOrder()], {})
		const summary = await service.run(NOW)
		expect(orderRepository.update).not.toHaveBeenCalled()
		expect(summary).toEqual({ checked: 1, answered: 0, updated: 0, alerted: 0 })
	})

	it('asks for 60 days of orders and sends the phone as digits', async () => {
		const { service, orderRepository, trackingClient } = setup([makeOrder()], {})
		await service.run(NOW)
		expect(orderRepository.findTrackable).toHaveBeenCalledWith(
			expect.any(Array),
			new Date('2026-07-31T10:00:00.000Z')
		)
		expect(trackingClient.getStatuses).toHaveBeenCalledWith([
			{ ttn: '20450000000001', phone: '380670000000' }
		])
	})

	it('does not call Nova Post when there is nothing to track', async () => {
		const { service, trackingClient } = setup([], {})
		await service.run(NOW)
		expect(trackingClient.getStatuses).not.toHaveBeenCalled()
	})
})
