import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { buildSalesReport, type ReportSourceOrder } from './report.builder'
import { salesReportTemplate } from './report.template'

function makeOrder(overrides: Partial<ReportSourceOrder> = {}): ReportSourceOrder {
	return {
		order_number: 'FL-1',
		createdAt: new Date('2026-09-10T09:00:00.000Z'),
		order_status: OrderStatus.COMPLETED,
		payment_method: PaymentMethod.COD,
		payment_status: PaymentStatus.PAID,
		delivery_method: DeliveryMethod.NOVA_POST,
		nova_post_ttn: null,
		customer: { name: 'Іван Петренко', phone: '+380670000000', email: 'ivan@example.com' },
		items: [
			{
				name: 'Kingroon PETG — Чорний (Black)',
				sku: 'FL-000253',
				vendor_sku: null,
				price: 600,
				quantity: 2
			}
		],
		subtotal_price: 1200,
		total_price: 1200,
		applied_discount: null,
		...overrides
	}
}

const render = (orders: ReportSourceOrder[]) =>
	salesReportTemplate(
		buildSalesReport(orders, {
			dateFrom: '2026-09-01',
			dateTo: '2026-09-30',
			orderStatuses: null,
			paymentStatuses: null
		})
	)

/** The register section only — section 1 prints the same product names. */
const register = (html: string) => html.slice(html.indexOf('2. Реєстр замовлень'))

describe('salesReportTemplate — реєстр замовлень', () => {
	it('prints each position of the order under its row', () => {
		const html = register(
			render([
				makeOrder({
					items: [
						{
							name: 'Kingroon PETG — Чорний (Black)',
							sku: 'FL-000253',
							vendor_sku: null,
							price: 600,
							quantity: 2
						},
						{
							name: 'Sunlu PLA — Білий (White)',
							sku: 'FL-000100',
							vendor_sku: null,
							price: 450,
							quantity: 1
						}
					],
					subtotal_price: 1650,
					total_price: 1650
				})
			])
		)

		expect(html).toContain('Kingroon PETG — Чорний (Black) · 2 × 600,00 = <strong>1')
		expect(html).toContain('Sunlu PLA — Білий (White) · 1 × 450,00 = <strong>450,00</strong>')
	})

	it('prints the TTN of a shipped order', () => {
		const html = register(render([makeOrder({ nova_post_ttn: '20451234567890' })]))
		expect(html).toContain('<td class="mono">20451234567890</td>')
	})

	it('prints a dash for pickup, even if a TTN was stored by mistake', () => {
		const html = register(
			render([makeOrder({ delivery_method: DeliveryMethod.PICKUP, nova_post_ttn: '123' })])
		)
		expect(html).toContain('<td class="mono">—</td>')
		expect(html).not.toContain('>123<')
	})

	it('flags a shipped order that still has no TTN', () => {
		const html = register(render([makeOrder({ nova_post_ttn: null })]))
		expect(html).toContain('<td class="mono"><span class="muted">немає</span></td>')
	})

	it('escapes product names', () => {
		const html = register(
			render([
				makeOrder({
					items: [
						{ name: '<b>x</b>', sku: 'FL-1', vendor_sku: null, price: 1, quantity: 1 }
					],
					subtotal_price: 1,
					total_price: 1
				})
			])
		)
		expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
		expect(html).not.toContain('<b>x</b>')
	})
})

describe('salesReportTemplate — рядок фільтрів', () => {
	const header = (html: string) => html.slice(0, html.indexOf('1. Продані товари'))

	it('names every selected status, in the order chosen', () => {
		const html = header(
			salesReportTemplate(
				buildSalesReport([makeOrder()], {
					dateFrom: '2026-09-01',
					dateTo: '2026-09-30',
					orderStatuses: [OrderStatus.COMPLETED, OrderStatus.DELIVERED],
					paymentStatuses: [PaymentStatus.PAID]
				})
			)
		)
		expect(html).toContain('Статус замовлення: Виконане, Доставлене')
		expect(html).toContain('Статус оплати: Оплачено')
	})

	it('says «усі» when a dimension was not limited', () => {
		const html = header(render([makeOrder()]))
		expect(html).toContain('Статус замовлення: усі')
		expect(html).toContain('Статус оплати: усі')
	})
})
