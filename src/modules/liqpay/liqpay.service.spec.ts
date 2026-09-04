import { BadRequestException, NotFoundException } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import {
	liqpaySignature,
	orderAccessToken,
	verifyOrderAccessToken
} from 'src/common/services/crypto.util'
import { OrderStatus, PaymentMethod, PaymentProvider, PaymentStatus } from 'src/common/types/enums'
import { LiqpayService } from './liqpay.service'

// LiqpayService only needs PaymentProvidersService as a DI token; importing the real module pulls
// in payment-provider.schema.ts, whose `@Prop({ enum: PaymentProvider })` lacks `type: String` and
// makes @nestjs/mongoose throw CannotDetermineTypeError under ts-jest (isolatedModules transpile).
jest.mock('src/modules/payment-providers/payment-providers.service', () => ({
	PaymentProvidersService: class PaymentProvidersService {}
}))

const ORDER_NUMBER = 'FO-0000123'
const CREDS = { public_key: 'pub', private_key: 'priv', sandbox: true }

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
	_id: 'order-object-id',
	order_number: ORDER_NUMBER,
	payment_method: PaymentMethod.LIQPAY,
	payment_status: PaymentStatus.PENDING,
	order_status: OrderStatus.NEW,
	total_price: 1234.5,
	...overrides
})

type OrderFixture = ReturnType<typeof buildOrder>

const buildService = (order: OrderFixture | null, creds = CREDS) => {
	const orderService = {
		findByNumber: order
			? jest.fn().mockResolvedValue(order)
			: jest.fn().mockRejectedValue(new NotFoundException(`Order ${ORDER_NUMBER} not found`)),
		applyGatewayPaymentResult: jest.fn().mockResolvedValue(undefined)
	}
	const paymentProviders = { getActiveCredentials: jest.fn().mockResolvedValue(creds) }
	const service = new LiqpayService(orderService as never, paymentProviders as never)
	return { service, orderService, paymentProviders }
}

const decodeData = (data: string) =>
	JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as Record<string, unknown>

describe('LiqpayService.buildCheckout', () => {
	it('builds a signed checkout payload for a pending LiqPay order', async () => {
		const { service, orderService, paymentProviders } = buildService(buildOrder())

		const { data, signature, action_url } = await service.buildCheckout(ORDER_NUMBER)
		const params = decodeData(data)

		expect(orderService.findByNumber).toHaveBeenCalledWith(ORDER_NUMBER)
		expect(paymentProviders.getActiveCredentials).toHaveBeenCalledWith(PaymentProvider.LIQPAY)
		expect(action_url).toBe('https://www.liqpay.ua/api/3/checkout')
		expect(signature).toBe(liqpaySignature('priv', data))
		expect(params).toMatchObject({
			version: 3,
			public_key: 'pub',
			action: 'pay',
			currency: 'UAH',
			sandbox: '1'
		})
		expect(params.amount).toBe(1234.5)
		expect(params.order_id).toBe(ORDER_NUMBER)
		expect(params.server_url).toBe(`${ENV.PUBLIC_API_URL}/liqpay/callback`)
		expect(String(params.server_url).endsWith('/liqpay/callback')).toBe(true)
	})

	it('puts the order access token into result_url', async () => {
		const { service } = buildService(buildOrder())

		const { data } = await service.buildCheckout(ORDER_NUMBER)
		const resultUrl = String(decodeData(data).result_url)

		expect(resultUrl).toBe(
			`${ENV.FRONTEND_URL}/checkout/success?order=FO-0000123&payment=LIQPAY&token=${orderAccessToken('FO-0000123')}`
		)
		const token = /[?&]token=([a-f0-9]{32})$/.exec(resultUrl)?.[1]
		expect(token).toBeDefined()
		expect(verifyOrderAccessToken(ORDER_NUMBER, token as string)).toBe(true)
	})

	it('marks sandbox "0" for live credentials', async () => {
		const { service } = buildService(buildOrder(), { ...CREDS, sandbox: false })

		const { data } = await service.buildCheckout(ORDER_NUMBER)

		expect(decodeData(data).sandbox).toBe('0')
	})

	it('rejects a non-LiqPay order before touching the provider credentials', async () => {
		const { service, paymentProviders } = buildService(
			buildOrder({ payment_method: PaymentMethod.IBAN })
		)

		const err = (await service.buildCheckout(ORDER_NUMBER).catch((e: unknown) => e)) as Error

		expect(err).toBeInstanceOf(BadRequestException)
		expect(err.message).toBe('Order is not a LiqPay order')
		expect(paymentProviders.getActiveCredentials).not.toHaveBeenCalled()
	})

	it('rejects an order that is already paid', async () => {
		const { service, paymentProviders } = buildService(
			buildOrder({ payment_status: PaymentStatus.PAID })
		)

		const err = (await service.buildCheckout(ORDER_NUMBER).catch((e: unknown) => e)) as Error

		expect(err).toBeInstanceOf(BadRequestException)
		expect(err.message).toBe('Order is already paid')
		expect(paymentProviders.getActiveCredentials).not.toHaveBeenCalled()
	})

	it('allows a retry for PENDING and FAILED orders', async () => {
		for (const payment_status of [PaymentStatus.PENDING, PaymentStatus.FAILED]) {
			const { service } = buildService(buildOrder({ payment_status }))
			await expect(service.buildCheckout(ORDER_NUMBER)).resolves.toHaveProperty('data')
		}
	})

	it.each([
		['VOIDED payment', { payment_status: PaymentStatus.VOIDED }],
		['REFUNDED payment', { payment_status: PaymentStatus.REFUNDED }],
		['CANCELLED order', { order_status: OrderStatus.CANCELLED }]
	])('rejects a cancelled order (%s) so it can never be charged', async (_label, overrides) => {
		const { service, paymentProviders } = buildService(buildOrder(overrides))

		const err = (await service.buildCheckout(ORDER_NUMBER).catch((e: unknown) => e)) as Error

		expect(err).toBeInstanceOf(BadRequestException)
		expect(err.message).toBe('Order is cancelled')
		expect(paymentProviders.getActiveCredentials).not.toHaveBeenCalled()
	})

	it('propagates the 404 of an unknown order', async () => {
		const { service, paymentProviders } = buildService(null)

		await expect(service.buildCheckout(ORDER_NUMBER)).rejects.toBeInstanceOf(NotFoundException)
		expect(paymentProviders.getActiveCredentials).not.toHaveBeenCalled()
	})
})
