import { DeliveryMethod, OrderStatus, PaymentStatus } from 'src/common/types/enums'
import { orderCashConfirmationTemplate } from './order-cash-confirmation.template/order-cash-confirmation.template'
import { orderCodConfirmationTemplate } from './order-cod-confirmation.template/order-cod-confirmation.template'
import { orderIbanConfirmationTemplate } from './order-iban-confirmation.template/order-iban-confirmation.template'
import { orderPaidConfirmationTemplate } from './order-paid-confirmation.template/order-paid-confirmation.template'
import { serviceOrderCreatedTemplate } from './service/order-iban-confirmation.template/order-created-service.template'
import { wholesaleInquiryCreatedTemplate } from './service/wholesale-inquiry.template/wholesale-inquiry-created.template'

/** A phishing link dressed as part of a Fillando email — what an unescaped field would render. */
const PAYLOAD = '<a href="https://evil.example">Підтвердіть оплату тут</a>'
const ESCAPED = '&lt;a href=&quot;https://evil.example&quot;&gt;Підтвердіть оплату тут&lt;/a&gt;'

const order = {
	orderNumber: 'FL-260901',
	orderStatus: OrderStatus.NEW,
	paymentStatus: PaymentStatus.PENDING,
	customer: { name: PAYLOAD, phone: PAYLOAD, email: 'ivan@example.com' },
	items: [{ name: PAYLOAD, sku: 'FL-1', vendor_sku: null, price: 459, quantity: 2, image: null }],
	subtotalPrice: 918,
	totalPrice: 826.2,
	appliedDiscount: { code: PAYLOAD, discount_percent: 10, discount_amount: 91.8 },
	deliveryMethod: DeliveryMethod.COURIER,
	deliveryAddress: {
		city_name: PAYLOAD,
		warehouse_description: null,
		street: PAYLOAD,
		building: '1',
		apartment: PAYLOAD
	}
}

describe('email templates — buyer-typed text reaches the mail client as text', () => {
	it.each([
		['order paid', () => orderPaidConfirmationTemplate(order as never)],
		['COD confirmation', () => orderCodConfirmationTemplate(order as never)],
		['cash confirmation', () => orderCashConfirmationTemplate(order as never)],
		['IBAN confirmation', () => orderIbanConfirmationTemplate(order as never)],
		[
			'new order, to the shop',
			() =>
				serviceOrderCreatedTemplate({
					...order,
					customerEmail: PAYLOAD,
					paymentType: 'IBAN'
				} as never)
		],
		[
			'wholesale inquiry, to the shop',
			() =>
				wholesaleInquiryCreatedTemplate({
					name: PAYLOAD,
					phone: PAYLOAD,
					email: PAYLOAD,
					quantity: PAYLOAD,
					comment: PAYLOAD
				})
		]
	])('%s', (_, render) => {
		const html = render()
		expect(html).not.toContain('<a href="https://evil.example"')
		expect(html).toContain(ESCAPED)
	})
})
