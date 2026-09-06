import { Injectable, Logger } from '@nestjs/common'
import { Resend } from 'resend'
import { ENV, SUPPORT } from 'src/common/constants'
import { PaymentMethod } from 'src/common/types/enums'
import { formatPaymentMethod } from 'src/modules/order/helpers/format.helpers'
import {
	OrderCashConfirmationData,
	orderCashConfirmationTemplate
} from './templates/order-cash-confirmation.template/order-cash-confirmation.template'
import {
	OrderCodConfirmationData,
	orderCodConfirmationTemplate
} from './templates/order-cod-confirmation.template/order-cod-confirmation.template'
import {
	OrderIbanConfirmationData,
	orderIbanConfirmationTemplate
} from './templates/order-iban-confirmation.template/order-iban-confirmation.template'
import {
	OrderPaidConfirmationData,
	orderPaidConfirmationTemplate
} from './templates/order-paid-confirmation.template/order-paid-confirmation.template'
import {
	serviceOrderCreatedTemplate,
	ServiceOrderCreatedEmailData
} from './templates/service/order-iban-confirmation.template/order-created-service.template'
import {
	wholesaleInquiryCreatedTemplate,
	WholesaleInquiryCreatedEmailData
} from './templates/service/wholesale-inquiry.template/wholesale-inquiry-created.template'

@Injectable()
export class EmailService {
	private readonly logger = new Logger(EmailService.name)
	private readonly resend = new Resend(ENV.RESEND_API_KEY)

	private async send(options: {
		to: string | string[]
		subject: string
		html: string
		from?: string
		attachments?: { content: Buffer; filename: string }[]
	}) {
		const { to, subject, html, from = 'Fillando <noreply@fillando.com>', attachments } = options
		if (!ENV.ALLOW_EMAIL_SENDING) {
			this.logger.debug(
				{ to, subject },
				'Email sending skipped because ALLOW_EMAIL_SENDING is disabled'
			)
			return { id: 'skipped' }
		}
		const { data, error } = await this.resend.emails.send({
			from,
			to,
			subject,
			html,
			replyTo: SUPPORT.EMAIL,
			attachments
		})
		if (error) {
			this.logger.error({ error }, 'Failed to send email')
			throw new Error(error.message)
		}
		return data
	}

	async sendOrderIbanConfirmation(
		to: string,
		orderNumber: string,
		details: Omit<OrderIbanConfirmationData, 'orderNumber'>
	): Promise<void> {
		const customerEmail = this.send({
			to,
			subject: `Замовлення ${orderNumber} успішно створено`,
			html: orderIbanConfirmationTemplate({ orderNumber, ...details })
		})

		const serviceData: ServiceOrderCreatedEmailData = {
			orderNumber,
			orderStatus: details.orderStatus,
			paymentStatus: details.paymentStatus,
			paymentType: 'IBAN',
			customer: {
				name: details.customer.name,
				phone: details.customer.phone,
				email: to
			},
			items: details.items.map(item => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku,
				image: item.image,
				price: item.price,
				quantity: item.quantity
			})),
			subtotalPrice: details.subtotalPrice,
			totalPrice: details.totalPrice,
			appliedDiscount: details.appliedDiscount ?? null,
			deliveryMethod: details.deliveryMethod,
			deliveryAddress: details.deliveryAddress
		}

		const serviceEmail = this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Нове замовлення ${orderNumber}`,
			html: serviceOrderCreatedTemplate(serviceData)
		})

		await Promise.all([customerEmail, serviceEmail])
	}

	async sendOrderCashConfirmation(
		to: string,
		orderNumber: string,
		details: Omit<OrderCashConfirmationData, 'orderNumber'>
	): Promise<void> {
		const customerEmail = this.send({
			to,
			subject: `Замовлення ${orderNumber} успішно створено`,
			html: orderCashConfirmationTemplate({ orderNumber, ...details })
		})

		const serviceData: ServiceOrderCreatedEmailData = {
			orderNumber,
			orderStatus: details.orderStatus,
			paymentStatus: details.paymentStatus,
			paymentType: 'CASH',
			customer: {
				name: details.customer.name,
				phone: details.customer.phone,
				email: to
			},
			items: details.items.map(item => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku,
				image: item.image,
				price: item.price,
				quantity: item.quantity
			})),
			subtotalPrice: details.subtotalPrice,
			totalPrice: details.totalPrice,
			appliedDiscount: details.appliedDiscount ?? null,
			deliveryMethod: details.deliveryMethod,
			deliveryAddress: details.deliveryAddress
		}

		const serviceEmail = this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Нове замовлення ${orderNumber}`,
			html: serviceOrderCreatedTemplate(serviceData)
		})

		await Promise.all([customerEmail, serviceEmail])
	}

	async sendOrderCodConfirmation(
		to: string,
		orderNumber: string,
		details: Omit<OrderCodConfirmationData, 'orderNumber'>
	): Promise<void> {
		const customerEmail = this.send({
			to,
			subject: `Замовлення ${orderNumber} успішно створено`,
			html: orderCodConfirmationTemplate({ orderNumber, ...details })
		})

		const serviceData: ServiceOrderCreatedEmailData = {
			orderNumber,
			orderStatus: details.orderStatus,
			paymentStatus: details.paymentStatus,
			paymentType: 'Накладний платіж',
			customer: {
				name: details.customer.name,
				phone: details.customer.phone,
				email: to
			},
			items: details.items.map(item => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku,
				image: item.image,
				price: item.price,
				quantity: item.quantity
			})),
			subtotalPrice: details.subtotalPrice,
			totalPrice: details.totalPrice,
			appliedDiscount: details.appliedDiscount ?? null,
			deliveryMethod: details.deliveryMethod,
			deliveryAddress: details.deliveryAddress
		}

		const serviceEmail = this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Нове замовлення ${orderNumber}`,
			html: serviceOrderCreatedTemplate(serviceData)
		})

		await Promise.all([customerEmail, serviceEmail])
	}

	async sendOrderPaidConfirmation(
		to: string,
		orderNumber: string,
		details: Omit<OrderPaidConfirmationData, 'orderNumber'>
	): Promise<void> {
		const customerEmail = this.send({
			to,
			subject: `Замовлення ${orderNumber} оплачено`,
			html: orderPaidConfirmationTemplate({ orderNumber, ...details })
		})

		const serviceData: ServiceOrderCreatedEmailData = {
			orderNumber,
			orderStatus: details.orderStatus,
			paymentStatus: details.paymentStatus,
			paymentType: 'LiqPay',
			customer: {
				name: details.customer.name,
				phone: details.customer.phone,
				email: to
			},
			items: details.items.map(item => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku,
				image: item.image,
				price: item.price,
				quantity: item.quantity
			})),
			subtotalPrice: details.subtotalPrice,
			totalPrice: details.totalPrice,
			appliedDiscount: details.appliedDiscount ?? null,
			deliveryMethod: details.deliveryMethod,
			deliveryAddress: details.deliveryAddress
		}

		const serviceEmail = this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Замовлення ${orderNumber} оплачено (LiqPay)`,
			html: serviceOrderCreatedTemplate(serviceData)
		})

		await Promise.all([customerEmail, serviceEmail])
	}

	/**
	 * A payment landed on an order that had already been cancelled.
	 *
	 * Service-only: the customer must NOT receive a "paid" confirmation for an
	 * order that no longer exists for them. The admin has to refund the money.
	 */
	async sendCancelledOrderPaidNotification(
		customerEmail: string,
		orderNumber: string,
		details: Omit<OrderPaidConfirmationData, 'orderNumber'>
	): Promise<void> {
		const serviceData: ServiceOrderCreatedEmailData = {
			orderNumber,
			orderStatus: details.orderStatus,
			paymentStatus: details.paymentStatus,
			paymentType: 'LiqPay',
			customer: {
				name: details.customer.name,
				phone: details.customer.phone,
				email: customerEmail
			},
			items: details.items.map(item => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku,
				image: item.image,
				price: item.price,
				quantity: item.quantity
			})),
			subtotalPrice: details.subtotalPrice,
			totalPrice: details.totalPrice,
			appliedDiscount: details.appliedDiscount ?? null,
			deliveryMethod: details.deliveryMethod,
			deliveryAddress: details.deliveryAddress
		}

		await this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Оплата надійшла по скасованому замовленню ${orderNumber} — потрібне повернення`,
			html: serviceOrderCreatedTemplate(serviceData)
		})
	}

	/**
	 * The buyer switched an unpaid order to an offline method (TD-0009 §5.4.1). The customer gets
	 * the confirmation of the new method — the same template as at creation, with its opening
	 * sentence changed — and the service a note of the change, so nobody keeps waiting for a card
	 * payment that will not come.
	 */
	async sendPaymentMethodChanged(
		to: string,
		orderNumber: string,
		method: PaymentMethod.COD | PaymentMethod.IBAN | PaymentMethod.CASH,
		previousMethod: PaymentMethod,
		details: Omit<OrderCodConfirmationData, 'orderNumber' | 'variant'>
	): Promise<void> {
		const template = {
			[PaymentMethod.COD]: orderCodConfirmationTemplate,
			[PaymentMethod.IBAN]: orderIbanConfirmationTemplate,
			[PaymentMethod.CASH]: orderCashConfirmationTemplate
		}[method]

		const customerEmail = this.send({
			to,
			subject: `Замовлення ${orderNumber}: спосіб оплати змінено`,
			html: template({ orderNumber, ...details, variant: 'payment_method_changed' })
		})

		const serviceEmail = this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Зміна способу оплати ${orderNumber}`,
			html: serviceOrderCreatedTemplate({
				...this.toServiceData(orderNumber, to, details),
				heading: 'Зміна способу оплати',
				paymentType: `${formatPaymentMethod(method)} (було: ${formatPaymentMethod(previousMethod)})`
			})
		})

		await Promise.all([customerEmail, serviceEmail])
	}

	/**
	 * LiqPay confirmed a payment after the buyer had switched the order to an offline method
	 * (TD-0009 §5.4.2). The customer did pay, so they get the ordinary paid confirmation; the
	 * service mail says so explicitly, because the admin must not also collect the offline sum.
	 */
	async sendLiqpayPaidAfterMethodChange(
		to: string,
		orderNumber: string,
		abandonedMethod: PaymentMethod,
		details: Omit<OrderPaidConfirmationData, 'orderNumber'>,
		options: { inFulfilment: boolean; ttn: string | null }
	): Promise<void> {
		const customerEmail = this.send({
			to,
			subject: `Замовлення ${orderNumber} оплачено`,
			html: orderPaidConfirmationTemplate({ orderNumber, ...details })
		})

		const abandoned = formatPaymentMethod(abandonedMethod)
		// Loudest when the parcel may already carry a COD invoice: the buyer must not pay twice.
		const subject = options.inFulfilment
			? `ТЕРМІНОВО: замовлення ${orderNumber} оплачено карткою вже в обробці — зняти ${abandoned}${options.ttn ? ` на ТТН ${options.ttn}` : ''}`
			: `Оплата LiqPay надійшла після зміни способу оплати ${orderNumber} — не збирати ${abandoned}`
		const serviceEmail = this.send({
			to: ENV.SERVICE_EMAIL,
			subject,
			html: serviceOrderCreatedTemplate({
				...this.toServiceData(orderNumber, to, details),
				heading: options.inFulfilment
					? 'Зняти накладний платіж: оплату отримано карткою'
					: 'Оплата LiqPay після зміни способу оплати',
				paymentType: `LiqPay (покупець перед тим обрав: ${abandoned})`
			})
		})

		await Promise.all([customerEmail, serviceEmail])
	}

	/** The service-mail payload every order mail shares; `paymentType` is filled by the caller. */
	private toServiceData(
		orderNumber: string,
		customerEmail: string,
		details: Omit<OrderCodConfirmationData, 'orderNumber' | 'variant'>
	): ServiceOrderCreatedEmailData {
		return {
			orderNumber,
			orderStatus: details.orderStatus,
			paymentStatus: details.paymentStatus,
			paymentType: '',
			customer: {
				name: details.customer.name,
				phone: details.customer.phone,
				email: customerEmail
			},
			items: details.items.map(item => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku,
				image: item.image,
				price: item.price,
				quantity: item.quantity
			})),
			subtotalPrice: details.subtotalPrice,
			totalPrice: details.totalPrice,
			appliedDiscount: details.appliedDiscount ?? null,
			deliveryMethod: details.deliveryMethod,
			deliveryAddress: details.deliveryAddress
		}
	}

	async sendWholesaleInquiryNotification(data: WholesaleInquiryCreatedEmailData): Promise<void> {
		await this.send({
			to: ENV.SERVICE_EMAIL,
			subject: `Нова заявка на оптову закупку від ${data.name}`,
			html: wholesaleInquiryCreatedTemplate(data)
		})
	}

	async sendVendorOrderEmail(
		to: string,
		subject: string,
		body: string,
		attachments?: { content: Buffer; filename: string }[]
	): Promise<void> {
		await this.send({ to, subject, html: body, attachments })
	}
}
