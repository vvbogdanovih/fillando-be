import {
	DeliveryMethod,
	InvoiceAudience,
	OrderStatus,
	PaymentMethod,
	PaymentStatus
} from 'src/common/types/enums'
import { invoiceTemplate, type InvoiceData } from './invoice.template'

const DATA: InvoiceData = {
	orderNumber: 'FL-260901',
	createdAt: new Date('2026-09-10T09:00:00.000Z'),
	orderStatus: OrderStatus.COMPLETED,
	paymentMethod: PaymentMethod.COD,
	paymentStatus: PaymentStatus.PENDING,
	customer: { name: 'Іван Петренко', phone: '+380670000000', email: 'ivan@example.com' },
	items: [
		{
			name: 'Kingroon PETG — Чорний (Black)',
			sku: 'FL-000253',
			vendor_sku: 'KR-PETG-BLK-SECRET',
			price: 459,
			quantity: 2,
			image: null
		}
	],
	subtotalPrice: 918,
	totalPrice: 918,
	appliedDiscount: null,
	deliveryMethod: DeliveryMethod.PICKUP,
	deliveryAddress: null,
	novaPostTtn: null,
	orderComment: null,
	adminComment: 'Дякуємо за замовлення'
}

describe('invoiceTemplate — audience', () => {
	it('prints the supplier article on the internal copy, by default', () => {
		const html = invoiceTemplate(DATA)
		expect(html).toContain('Vendor SKU')
		expect(html).toContain('KR-PETG-BLK-SECRET')
		expect(html).toContain('Коментар адміністратора')
	})

	it('drops the supplier article column from the customer copy', () => {
		const html = invoiceTemplate(DATA, InvoiceAudience.CUSTOMER)
		expect(html).not.toContain('Vendor SKU')
		expect(html).not.toContain('KR-PETG-BLK-SECRET')
		// Everything the buyer does need stays.
		expect(html).toContain('FL-000253')
		expect(html).toContain('Kingroon PETG — Чорний (Black)')
	})

	it('keeps header and body cells aligned on the customer copy', () => {
		const html = invoiceTemplate(DATA, InvoiceAudience.CUSTOMER)
		const table = html.slice(html.indexOf('<thead>'), html.indexOf('</tbody>'))
		const headers = table.match(/<th /g)?.length
		const cells = table.slice(table.indexOf('<tbody>')).match(/<td /g)?.length
		expect(headers).toBe(7)
		expect(cells).toBe(7)
	})

	it('labels the admin comment as the shop’s on the customer copy', () => {
		const html = invoiceTemplate(DATA, InvoiceAudience.CUSTOMER)
		expect(html).toContain('Коментар магазину')
		expect(html).not.toContain('Коментар адміністратора')
	})
})

describe('invoiceTemplate — buyer-typed text is escaped', () => {
	const PAYLOAD = '<img src=x onerror="alert(1)"><a href="https://evil.example">Оплатити тут</a>'

	it.each([
		['name', { customer: { ...DATA.customer, name: PAYLOAD } }],
		['phone', { customer: { ...DATA.customer, phone: PAYLOAD } }],
		['email', { customer: { ...DATA.customer, email: PAYLOAD } }],
		['order comment', { orderComment: PAYLOAD }],
		['admin comment', { adminComment: PAYLOAD }],
		['TTN', { novaPostTtn: PAYLOAD }],
		[
			'courier address',
			{
				deliveryMethod: DeliveryMethod.COURIER,
				deliveryAddress: {
					city_name: 'Київ',
					warehouse_description: null,
					warehouse_number: null,
					street: PAYLOAD,
					building: '1',
					apartment: null
				}
			}
		],
		[
			'discount code',
			{ appliedDiscount: { code: PAYLOAD, discount_percent: 10, discount_amount: 91.8 } }
		]
	] as [string, Partial<InvoiceData>][])('%s', (_, overrides) => {
		const html = invoiceTemplate({ ...DATA, ...overrides })
		expect(html).not.toContain('<img src=x')
		expect(html).not.toContain('<a href=')
		expect(html).toContain(
			'&lt;a href=&quot;https://evil.example&quot;&gt;Оплатити тут&lt;/a&gt;'
		)
	})

	it('cannot break out of the image src attribute', () => {
		const html = invoiceTemplate({
			...DATA,
			items: [{ ...DATA.items[0], image: 'https://cdn.example/a.jpg" onerror="alert(1)' }]
		})
		expect(html).toContain('src="https://cdn.example/a.jpg&quot; onerror=&quot;alert(1)"')
	})

	it('still prints ordinary text as is', () => {
		const html = invoiceTemplate({
			...DATA,
			orderComment: "Прошу зателефонувати о 18:00 — під'їзд 2"
		})
		expect(html).toContain('Прошу зателефонувати о 18:00 — під&#39;їзд 2')
	})
})

describe('invoiceTemplate — ручна знижка', () => {
	const withDiscount: InvoiceData = {
		...DATA,
		totalPrice: 868,
		manualDiscount: { amount: 50, reason: 'ВНУТРІШНЯ-ПРИЧИНА' }
	}

	it('prints the discount and its reason on the internal copy', () => {
		const html = invoiceTemplate(withDiscount)
		expect(html).toContain('Знижка магазину')
		expect(html).toContain('ВНУТРІШНЯ-ПРИЧИНА')
	})

	it('prints the discount without the reason on the customer copy', () => {
		const html = invoiceTemplate(withDiscount, InvoiceAudience.CUSTOMER)
		expect(html).toContain('Знижка магазину')
		expect(html).not.toContain('ВНУТРІШНЯ-ПРИЧИНА')
	})
})
