import { Injectable, Logger } from '@nestjs/common'
import { Resend } from 'resend'
import { ENV } from 'src/common/constants'
import {
	OrderCashConfirmationData,
	orderCashConfirmationTemplate
} from './templates/order-cash-confirmation.template/order-cash-confirmation.template'
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
			replyTo: 'vvbogdanovih@gmail.com',
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
