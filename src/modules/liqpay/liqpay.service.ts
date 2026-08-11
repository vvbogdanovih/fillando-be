import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { PaymentMethod, PaymentProvider } from 'src/common/types/enums'
import { liqpaySignature, verifyLiqpaySignature } from 'src/common/services/crypto.util'
import { OrderService } from 'src/modules/order/order.service'
import {
	PaymentProvidersService,
	ProviderCredentials
} from 'src/modules/payment-providers/payment-providers.service'

const LIQPAY_CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout'
const PAID_STATUSES = ['success', 'sandbox']
const FAILED_STATUSES = ['failure', 'error']
const AMOUNT_TOLERANCE = 0.01

interface LiqpayCallbackPayload {
	order_id?: string
	status?: string
	amount?: number
	currency?: string
	transaction_id?: number | string
	payment_id?: number | string
}

@Injectable()
export class LiqpayService {
	private readonly logger = new Logger(LiqpayService.name)

	constructor(
		private readonly orderService: OrderService,
		private readonly paymentProviders: PaymentProvidersService
	) {}

	/**
	 * Builds the signed payload the frontend auto-submits to the LiqPay checkout page.
	 */
	async buildCheckout(orderNumber: string) {
		const order = await this.orderService.findByNumber(orderNumber)
		if (order.payment_method !== PaymentMethod.LIQPAY) {
			throw new BadRequestException('Order is not a LiqPay order')
		}

		const creds = await this.paymentProviders.getActiveCredentials(PaymentProvider.LIQPAY)

		const params = {
			version: 3,
			public_key: creds.public_key,
			action: 'pay',
			amount: order.total_price,
			currency: 'UAH',
			description: `Оплата замовлення ${order.order_number}`,
			order_id: order.order_number,
			result_url: `${ENV.FRONTEND_URL}/checkout/success?order=${order.order_number}&payment=LIQPAY`,
			server_url: `${ENV.PUBLIC_API_URL}/liqpay/callback`,
			sandbox: creds.sandbox ? '1' : '0'
		}

		const data = Buffer.from(JSON.stringify(params)).toString('base64')
		const signature = liqpaySignature(creds.private_key, data)

		return { data, signature, action_url: LIQPAY_CHECKOUT_URL }
	}

	/**
	 * Handles the server-to-server callback. Always resolves (never throws) so the
	 * controller can return 200 — LiqPay retries on non-2xx responses.
	 */
	async handleCallback(data: string, signature: string): Promise<void> {
		let creds: ProviderCredentials
		try {
			creds = await this.paymentProviders.getActiveCredentials(PaymentProvider.LIQPAY)
		} catch (err: unknown) {
			this.logger.error({ err }, 'LiqPay callback received but no active provider configured')
			return
		}

		if (!verifyLiqpaySignature(creds.private_key, data, signature)) {
			this.logger.warn('LiqPay callback rejected: invalid signature')
			return
		}

		let payload: LiqpayCallbackPayload
		try {
			payload = JSON.parse(
				Buffer.from(data, 'base64').toString('utf8')
			) as LiqpayCallbackPayload
		} catch (err: unknown) {
			this.logger.warn({ err }, 'LiqPay callback rejected: malformed data')
			return
		}

		const orderNumber = payload.order_id
		if (!orderNumber) {
			this.logger.warn('LiqPay callback rejected: missing order_id')
			return
		}

		const order = await this.orderService.findByNumber(orderNumber).catch(() => null)
		if (!order) {
			this.logger.warn({ orderNumber }, 'LiqPay callback for unknown order')
			return
		}

		const status = payload.status ?? ''
		const isPaid = PAID_STATUSES.includes(status)
		const isFailed = FAILED_STATUSES.includes(status)

		if (isPaid) {
			if (
				payload.currency !== 'UAH' ||
				Math.abs((payload.amount ?? 0) - order.total_price) > AMOUNT_TOLERANCE
			) {
				this.logger.warn(
					{ orderNumber, amount: payload.amount, currency: payload.currency },
					'LiqPay callback amount/currency mismatch — not marking as paid'
				)
				return
			}
		} else if (!isFailed) {
			this.logger.log(
				{ orderNumber, status },
				'LiqPay callback intermediate status — ignored'
			)
			return
		}

		const transactionId = String(payload.transaction_id ?? payload.payment_id ?? '')
		await this.orderService.applyGatewayPaymentResult(orderNumber, isPaid, transactionId)
	}
}
