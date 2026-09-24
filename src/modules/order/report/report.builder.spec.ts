import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'
import { buildSalesReport, type ReportFilters, type ReportSourceOrder } from './report.builder'

const FILTERS: ReportFilters = {
	dateFrom: '2026-09-01',
	dateTo: '2026-09-30',
	orderStatus: null,
	paymentStatus: null
}

function makeOrder(overrides: Partial<ReportSourceOrder> = {}): ReportSourceOrder {
	return {
		order_number: 'FL-1',
		createdAt: new Date('2026-09-10T09:00:00.000Z'),
		order_status: OrderStatus.COMPLETED,
		payment_method: PaymentMethod.LIQPAY,
		payment_status: PaymentStatus.PAID,
		delivery_method: DeliveryMethod.NOVA_POST,
		customer: { name: 'Іван Петренко', phone: '+380670000000', email: 'ivan@example.com' },
		items: [
			{ name: 'PETG 1кг', sku: 'FL-000253', vendor_sku: 'KR-PETG-1', price: 600, quantity: 2 }
		],
		subtotal_price: 1200,
		total_price: 1200,
		applied_discount: null,
		...overrides
	}
}

describe('buildSalesReport — продані товари', () => {
	it('sums one SKU across orders and counts the orders it appeared in', () => {
		const report = buildSalesReport(
			[
				makeOrder({ order_number: 'FL-1' }),
				makeOrder({
					order_number: 'FL-2',
					items: [
						{
							name: 'PETG 1кг',
							sku: 'FL-000253',
							vendor_sku: 'KR-PETG-1',
							price: 600,
							quantity: 3
						}
					],
					subtotal_price: 1800,
					total_price: 1800
				})
			],
			FILTERS
		)

		expect(report.products).toHaveLength(1)
		expect(report.products[0]).toMatchObject({
			sku: 'FL-000253',
			quantity: 5,
			orders: 2,
			averagePrice: 600,
			amount: 3000
		})
	})

	it('averages a SKU sold at two different prices over the period', () => {
		const report = buildSalesReport(
			[
				makeOrder({ order_number: 'FL-1' }),
				makeOrder({
					order_number: 'FL-2',
					items: [
						{
							name: 'PETG 1кг',
							sku: 'FL-000253',
							vendor_sku: 'KR-PETG-1',
							price: 700,
							quantity: 2
						}
					],
					subtotal_price: 1400,
					total_price: 1400
				})
			],
			FILTERS
		)

		expect(report.products[0].amount).toBe(2600)
		expect(report.products[0].averagePrice).toBe(650)
	})

	it('orders the table by revenue, largest first', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					items: [
						{
							name: 'Дрібниця',
							sku: 'FL-000001',
							vendor_sku: null,
							price: 50,
							quantity: 1
						},
						{
							name: 'PETG 1кг',
							sku: 'FL-000253',
							vendor_sku: 'KR-PETG-1',
							price: 600,
							quantity: 2
						}
					],
					subtotal_price: 1250,
					total_price: 1250
				})
			],
			FILTERS
		)

		expect(report.products.map(product => product.sku)).toEqual(['FL-000253', 'FL-000001'])
	})
})

describe('buildSalesReport — підсумки', () => {
	it('carries the coupon discount into the totals', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					subtotal_price: 1200,
					total_price: 1080,
					applied_discount: { code: 'AUTUMN10', discount_amount: 120 }
				})
			],
			FILTERS
		)

		expect(report.totals).toMatchObject({
			orders: 1,
			positions: 1,
			units: 2,
			subtotal: 1200,
			discount: 120,
			total: 1080
		})
		expect(report.orders[0].discountCode).toBe('AUTUMN10')
	})

	it('splits what is paid from what is still awaited', () => {
		const report = buildSalesReport(
			[
				makeOrder({ order_number: 'FL-1', payment_status: PaymentStatus.PAID }),
				makeOrder({
					order_number: 'FL-2',
					payment_status: PaymentStatus.PENDING,
					payment_method: PaymentMethod.COD
				})
			],
			FILTERS
		)

		expect(report.totals.total).toBe(2400)
		expect(report.totals.paid).toBe(1200)
		expect(report.totals.awaiting).toBe(1200)
	})

	it('flags cancelled, returned and refunded orders that inflate the period', () => {
		const report = buildSalesReport(
			[
				makeOrder({ order_number: 'FL-1' }),
				makeOrder({
					order_number: 'FL-2',
					order_status: OrderStatus.CANCELLED,
					payment_status: PaymentStatus.VOIDED
				}),
				makeOrder({
					order_number: 'FL-3',
					order_status: OrderStatus.COMPLETED,
					payment_status: PaymentStatus.REFUNDED
				})
			],
			FILTERS
		)

		expect(report.nonRevenue).toEqual({ orders: 2, amount: 2400 })
	})

	it('reports no mismatch when the stored subtotal matches the line values', () => {
		expect(buildSalesReport([makeOrder()], FILTERS).subtotalMismatch).toBeNull()
	})

	it('reports the gap when a stored subtotal drifted away from its own items', () => {
		const report = buildSalesReport([makeOrder({ subtotal_price: 1000 })], FILTERS)

		expect(report.subtotalMismatch).toBe(200)
	})
})

describe('buildSalesReport — розрізи', () => {
	it('breaks the period down by payment status with shares that add up', () => {
		const report = buildSalesReport(
			[
				makeOrder({ order_number: 'FL-1', payment_status: PaymentStatus.PAID }),
				makeOrder({
					order_number: 'FL-2',
					payment_status: PaymentStatus.PAID,
					total_price: 2400,
					subtotal_price: 2400,
					items: [
						{
							name: 'PETG 1кг',
							sku: 'FL-000253',
							vendor_sku: 'KR-PETG-1',
							price: 600,
							quantity: 4
						}
					]
				}),
				makeOrder({ order_number: 'FL-3', payment_status: PaymentStatus.PENDING })
			],
			FILTERS
		)

		expect(report.byPaymentStatus).toEqual([
			{ key: PaymentStatus.PAID, orders: 2, amount: 3600, share: 75 },
			{ key: PaymentStatus.PENDING, orders: 1, amount: 1200, share: 25 }
		])
	})

	it('groups sales by Kyiv day, in calendar order', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					order_number: 'FL-2',
					// 00:30 on 11 September in Kyiv, still 10 September in UTC.
					createdAt: new Date('2026-09-10T21:30:00.000Z')
				}),
				makeOrder({
					order_number: 'FL-1',
					createdAt: new Date('2026-09-10T09:00:00.000Z')
				})
			],
			FILTERS
		)

		expect(report.byDay).toEqual([
			{ day: '2026-09-10', orders: 1, units: 2, amount: 1200 },
			{ day: '2026-09-11', orders: 1, units: 2, amount: 1200 }
		])
	})
})

describe('buildSalesReport — знижки в таблиці товарів', () => {
	it('allocates an order coupon across its lines in proportion to line value', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					items: [
						{
							name: 'PETG 1кг',
							sku: 'FL-000253',
							vendor_sku: 'KR-PETG-1',
							price: 600,
							quantity: 2
						},
						{
							name: 'Сопло 0.4',
							sku: 'FL-000010',
							vendor_sku: null,
							price: 300,
							quantity: 1
						}
					],
					subtotal_price: 1500,
					total_price: 1350,
					applied_discount: { code: 'AUTUMN10', discount_amount: 150 }
				})
			],
			FILTERS
		)

		const petg = report.products.find(product => product.sku === 'FL-000253')
		const nozzle = report.products.find(product => product.sku === 'FL-000010')

		expect(petg).toMatchObject({ grossAmount: 1200, discount: 120, amount: 1080 })
		expect(nozzle).toMatchObject({ grossAmount: 300, discount: 30, amount: 270 })
	})

	it('averages a position at what it actually sold for, not at its list price', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					subtotal_price: 1200,
					total_price: 1080,
					applied_discount: { code: 'AUTUMN10', discount_amount: 120 }
				})
			],
			FILTERS
		)

		// 600 ₴ a spool less its 10% share of the coupon, over two units.
		expect(report.products[0].averagePrice).toBe(540)
		expect(report.products[0].amount).toBe(1080)
	})

	it('keeps the allocated parts adding up to the order discount when it does not divide evenly', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					items: [
						{ name: 'Позиція А', sku: 'A', vendor_sku: null, price: 100, quantity: 1 },
						{ name: 'Позиція Б', sku: 'B', vendor_sku: null, price: 100, quantity: 1 },
						{ name: 'Позиція В', sku: 'C', vendor_sku: null, price: 100, quantity: 1 }
					],
					subtotal_price: 300,
					total_price: 290,
					applied_discount: { code: 'TEN', discount_amount: 10 }
				})
			],
			FILTERS
		)

		const allocated = report.products.reduce((acc, product) => acc + product.discount, 0)
		const net = report.products.reduce((acc, product) => acc + product.amount, 0)

		expect(allocated).toBe(10)
		expect(net).toBe(290)
	})

	it('leaves an order without a coupon at its line values', () => {
		const report = buildSalesReport([makeOrder()], FILTERS)

		expect(report.products[0]).toMatchObject({
			grossAmount: 1200,
			discount: 0,
			amount: 1200,
			averagePrice: 600
		})
	})

	it('ranks the table by what the positions brought in, not by their list value', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					order_number: 'FL-1',
					items: [
						{
							name: 'Дорога зі знижкою',
							sku: 'FL-HEAVY',
							vendor_sku: null,
							price: 1000,
							quantity: 1
						}
					],
					subtotal_price: 1000,
					total_price: 500,
					applied_discount: { code: 'HALF', discount_amount: 500 }
				}),
				makeOrder({
					order_number: 'FL-2',
					items: [
						{
							name: 'Дешевша без знижки',
							sku: 'FL-LIGHT',
							vendor_sku: null,
							price: 800,
							quantity: 1
						}
					],
					subtotal_price: 800,
					total_price: 800
				})
			],
			FILTERS
		)

		expect(report.products.map(product => product.sku)).toEqual(['FL-LIGHT', 'FL-HEAVY'])
	})

	it('does not read a discounted order as a subtotal mismatch', () => {
		const report = buildSalesReport(
			[
				makeOrder({
					subtotal_price: 1200,
					total_price: 1080,
					applied_discount: { code: 'AUTUMN10', discount_amount: 120 }
				})
			],
			FILTERS
		)

		expect(report.subtotalMismatch).toBeNull()
	})
})
