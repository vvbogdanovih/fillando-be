import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsDateString, IsEnum, IsOptional } from 'class-validator'
import { OrderStatus, PaymentStatus } from 'src/common/types/enums'

export class GenerateReportDto {
	@ApiProperty({ example: '2025-01-01' })
	@IsDateString()
	date_from: string

	@ApiProperty({ example: '2025-12-31' })
	@IsDateString()
	date_to: string

	@ApiPropertyOptional({ enum: OrderStatus })
	@IsOptional()
	@IsEnum(OrderStatus)
	order_status?: OrderStatus

	@ApiPropertyOptional({ enum: PaymentStatus })
	@IsOptional()
	@IsEnum(PaymentStatus)
	payment_status?: PaymentStatus
}
