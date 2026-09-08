import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	ServiceUnavailableException
} from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { OrderStatus, PaymentMethod, PaymentProvider, PaymentStatus } from 'src/common/types/enums'
import {
	liqpaySignature,
	orderAccessToken,
	verifyLiqpaySignature
} from 'src/common/services/crypto.util'
import { OrderService } from 'src/modules/order/order.service'
import { liqpayRetryAfterSeconds } from 'src/modules/order/helpers/liqpay-session.helpers'
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
			throw new BadRequestException('Це замовлення не оплачується карткою')
		}
		if (order.payment_status === PaymentStatus.PAID) {
			throw new BadRequestException('Замовлення вже оплачено')
		}
		// A cancelled order must never reach the gateway: a stale "try again" tab would charge
		// the buyer and land in the TD-0003 "paid after CANCELLED — refund manually" path.
		if (
			order.order_status === OrderStatus.CANCELLED ||
			order.payment_status === PaymentStatus.VOIDED ||
			order.payment_status === PaymentStatus.REFUNDED
		) {
			throw new BadRequestException('Замовлення скасовано')
		}
		// The provider credentials come before the claim on purpose. Reading them is a read, so
		// two tabs still race on the conditional claim below and exactly one wins — but a
		// provider that was switched off between the checkout render and this submit, or a key
		// that fails to decrypt, now throws before anything is stamped. Claiming first would
		// leave the buyer with a 15-minute clock for a session that was never opened.
		const creds = await this.readCredentials(order.order_number)

		// One live session at a time (TD-0009 §5.4.3). The claim is a conditional write, so two
		// tabs racing for the same order get exactly one payload; it is taken before the payload
		// is built and awaited, so a refused or failed claim never hands a payload out. A claim
		// on a FAILED payment also moves it back to PENDING, which is what stops a second tab
		// from opening a second live session for the same retry (see claimLiqpayCheckout).
		const claimed = await this.orderService.claimLiqpayCheckout(order._id)
		if (!claimed) {
			const fresh = await this.orderService.findByNumber(orderNumber)
			const retryAfter = liqpayRetryAfterSeconds(fresh)
			if (fresh.payment_status === PaymentStatus.PAID) {
				throw new BadRequestException('Замовлення вже оплачено')
			}
			if (retryAfter && retryAfter > 0) {
				throw new ConflictException({
					statusCode: 409,
					error: 'Conflict',
					code: 'LIQPAY_SESSION_ACTIVE',
					message:
						'Сторінку оплати вже відкрито. Якщо платіж не завершено, спробуйте ще раз трохи пізніше або оберіть інший спосіб оплати',
					retry_after_seconds: retryAfter
				})
			}
			throw new BadRequestException(
				'Оплату карткою для цього замовлення зараз не можна розпочати'
			)
		}

		const params = {
			version: 3,
			public_key: creds.public_key,
			action: 'pay',
			amount: order.total_price,
			currency: 'UAH',
			description: `Оплата замовлення ${order.order_number}`,
			order_id: order.order_number,
			result_url: `${ENV.FRONTEND_URL}/checkout/success?order=${order.order_number}&payment=LIQPAY&token=${orderAccessToken(order.order_number)}`,
			server_url: `${ENV.PUBLIC_API_URL}/liqpay/callback`,
			sandbox: creds.sandbox ? '1' : '0'
		}

		const data = Buffer.from(JSON.stringify(params)).toString('base64')
		const signature = liqpaySignature(creds.private_key, data)

		return { data, signature, action_url: LIQPAY_CHECKOUT_URL }
	}

	/**
	 * The active LiqPay credentials, or an honest «the card payment was not started» refusal.
	 * The gateway is unreachable for us, not the buyer's mistake, hence 503 — and the storefront
	 * echoes `message`, so it must say that nothing was started and what else can be done.
	 */
	private async readCredentials(orderNumber: string): Promise<ProviderCredentials> {
		try {
			return await this.paymentProviders.getActiveCredentials(PaymentProvider.LIQPAY)
		} catch (err: unknown) {
			this.logger.error(
				{ err },
				`LiqPay checkout for order ${orderNumber} could not read the provider credentials`
			)
			throw new ServiceUnavailableException({
				statusCode: 503,
				error: 'Service Unavailable',
				code: 'LIQPAY_UNAVAILABLE',
				message:
					'Оплату карткою не розпочато — сервіс оплати тимчасово недоступний. Кошти не списано: спробуйте ще раз за кілька хвилин або оберіть інший спосіб оплати'
			})
		}
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
