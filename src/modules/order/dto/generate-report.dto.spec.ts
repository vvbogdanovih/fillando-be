import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { OrderStatus, PaymentStatus } from 'src/common/types/enums'
import { GenerateReportDto } from './generate-report.dto'

const dto = (over: Record<string, unknown>) =>
	plainToInstance(GenerateReportDto, { date_from: '2026-09-01', date_to: '2026-09-30', ...over })

describe('GenerateReportDto status filters', () => {
	it('accepts a list of statuses per dimension', async () => {
		const value = dto({
			order_status: [OrderStatus.COMPLETED, OrderStatus.DELIVERED],
			payment_status: [PaymentStatus.PAID]
		})
		expect(await validate(value)).toEqual([])
		expect(value.order_status).toEqual([OrderStatus.COMPLETED, OrderStatus.DELIVERED])
	})

	it('still reads a single status as a one-item list', async () => {
		const value = dto({ order_status: OrderStatus.COMPLETED, payment_status: 'PAID' })
		expect(await validate(value)).toEqual([])
		expect(value.order_status).toEqual([OrderStatus.COMPLETED])
		expect(value.payment_status).toEqual([PaymentStatus.PAID])
	})

	it('accepts an empty list and no list at all', async () => {
		expect(await validate(dto({ order_status: [] }))).toEqual([])
		expect(await validate(dto({}))).toEqual([])
	})

	it('rejects an unknown status, a repeated one and a non-list', async () => {
		expect(await validate(dto({ order_status: ['DONE'] }))).not.toHaveLength(0)
		expect(
			await validate(dto({ payment_status: [PaymentStatus.PAID, PaymentStatus.PAID] }))
		).not.toHaveLength(0)
		expect(await validate(dto({ order_status: 42 }))).not.toHaveLength(0)
	})
})
