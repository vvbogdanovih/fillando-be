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
