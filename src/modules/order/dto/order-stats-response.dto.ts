import { ApiProperty } from '@nestjs/swagger'

export class OrderStatsPeriodDto {
	@ApiProperty({ example: '2026-09-01', description: 'Kyiv calendar day' })
	date_from: string

	@ApiProperty({ example: '2026-09-30', description: 'Kyiv calendar day' })
	date_to: string

	@ApiProperty({ example: 30, description: 'Inclusive day count' })
	days: number
}

export class OrderStatsTotalsDto {
	@ApiProperty({ description: 'Every order placed in the period, whatever became of it' })
	orders: number

	@ApiProperty({
		description:
			'Orders that are not revenue: CANCELLED / RETURNING / RETURNED, or payment VOIDED / REFUNDED'
	})
	cancelled: number

	@ApiProperty({ description: 'Orders whose payment_status is PAID' })
	paid: number

	@ApiProperty({ description: 'Sum of total_price over orders that are not cancelled, UAH' })
	revenue: number

	@ApiProperty({ description: 'revenue / (orders − cancelled); 0 when there is none' })
	avg_order_value: number

	@ApiProperty({ description: 'Units over orders that are not cancelled' })
	units: number
}

export class OrderStatsDayDto {
	@ApiProperty({ example: '2026-09-01' })
	day: string

	@ApiProperty({ minimum: 1, maximum: 7, description: 'ISO weekday: 1 Monday … 7 Sunday' })
	weekday: number

	@ApiProperty()
	orders: number

	@ApiProperty()
	cancelled: number

	@ApiProperty()
	paid: number

	@ApiProperty()
	revenue: number

	@ApiProperty()
	units: number
}

export class OrderStatsWeekdayDto {
	@ApiProperty({ minimum: 1, maximum: 7, description: 'ISO weekday: 1 Monday … 7 Sunday' })
	weekday: number

	@ApiProperty({ description: 'How many such weekdays the period contains, zero days included' })
	days_in_range: number

	@ApiProperty()
	orders: number

	@ApiProperty()
	revenue: number

	@ApiProperty({ description: 'orders / days_in_range' })
	avg_orders: number

	@ApiProperty({ description: 'revenue / days_in_range' })
	avg_revenue: number
}

export class OrderStatsHourDto {
	@ApiProperty({ minimum: 0, maximum: 23, description: 'Hour of the day in Kyiv' })
	hour: number

	@ApiProperty({ description: 'Every order placed in that hour, cancelled ones included' })
	orders: number

	@ApiProperty()
	revenue: number
}

export class OrderStatsHeatmapCellDto {
	@ApiProperty({ minimum: 1, maximum: 7 })
	weekday: number

	@ApiProperty({ minimum: 0, maximum: 23 })
	hour: number

	@ApiProperty({ description: 'Every order placed in that slot, cancelled ones included' })
	orders: number
}

export class OrderStatsBreakdownDto {
	@ApiProperty({ description: 'The enum value of the dimension (every value is listed)' })
	key: string

	@ApiProperty({ description: 'Every order with that value' })
	orders: number

	@ApiProperty({ description: 'Revenue of those orders — cancelled ones contribute 0' })
	revenue: number
}

export class OrderStatsProductDto {
	@ApiProperty({ nullable: true, type: String })
	variant_id: string | null

	@ApiProperty({ nullable: true, type: String })
	product_id: string | null

	@ApiProperty()
	sku: string

	@ApiProperty({ description: 'The name as last ordered' })
	name: string

	@ApiProperty({ description: 'Units over orders that are not cancelled' })
	quantity: number

	@ApiProperty({ description: 'Distinct orders the variant appeared in' })
	orders: number

	@ApiProperty({ description: 'Σ price × quantity before coupons, like the sales report' })
	revenue: number

	@ApiProperty({ description: 'revenue / quantity' })
	avg_price: number
}

export class OrderStatsResponseDto {
	@ApiProperty({ type: OrderStatsPeriodDto })
	period: OrderStatsPeriodDto

	@ApiProperty({ type: OrderStatsPeriodDto })
	previous_period: OrderStatsPeriodDto

	@ApiProperty({ example: '2026-10-16T09:00:00.000Z' })
	generated_at: string

	@ApiProperty({ type: OrderStatsTotalsDto })
	totals: OrderStatsTotalsDto

	@ApiProperty({ type: OrderStatsTotalsDto })
	previous_period_totals: OrderStatsTotalsDto

	@ApiProperty({
		type: [OrderStatsDayDto],
		description: 'Every day of the period, zero days included'
	})
	by_day: OrderStatsDayDto[]

	@ApiProperty({ type: [OrderStatsWeekdayDto], description: 'Always 7 rows, Monday first' })
	by_weekday: OrderStatsWeekdayDto[]

	@ApiProperty({ type: [OrderStatsHourDto], description: 'Always 24 rows' })
	by_hour: OrderStatsHourDto[]

	@ApiProperty({
		type: [OrderStatsHeatmapCellDto],
		description: 'Always 168 cells, weekday-major'
	})
	heatmap: OrderStatsHeatmapCellDto[]

	@ApiProperty({ type: [OrderStatsBreakdownDto] })
	by_payment_method: OrderStatsBreakdownDto[]

	@ApiProperty({ type: [OrderStatsBreakdownDto] })
	by_delivery_method: OrderStatsBreakdownDto[]

	@ApiProperty({ type: [OrderStatsBreakdownDto] })
	by_order_status: OrderStatsBreakdownDto[]

	@ApiProperty({ type: [OrderStatsBreakdownDto] })
	by_payment_status: OrderStatsBreakdownDto[]

	@ApiProperty({ type: [OrderStatsProductDto], description: 'At most 10' })
	top_products_by_revenue: OrderStatsProductDto[]

	@ApiProperty({ type: [OrderStatsProductDto], description: 'At most 10' })
	top_products_by_quantity: OrderStatsProductDto[]
}
