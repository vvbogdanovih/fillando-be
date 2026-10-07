import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Transform } from 'class-transformer'
import { ArrayUnique, IsArray, IsDateString, IsEnum, IsOptional } from 'class-validator'
import { OrderStatus, PaymentStatus } from 'src/common/types/enums'

/** A single value is read as a one-item list, so an older client sending one status still works. */
const toList = ({ value }: { value: unknown }) => (typeof value === 'string' ? [value] : value)

export class GenerateReportDto {
	@ApiProperty({ example: '2025-01-01' })
	@IsDateString()
	date_from: string

	@ApiProperty({ example: '2025-12-31' })
	@IsDateString()
	date_to: string

	@ApiPropertyOptional({
		enum: OrderStatus,
		isArray: true,
		description: 'Order statuses to include; absent or empty means every status'
	})
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@ArrayUnique()
	@IsEnum(OrderStatus, { each: true })
	order_status?: OrderStatus[]

	@ApiPropertyOptional({
		enum: PaymentStatus,
		isArray: true,
		description: 'Payment statuses to include; absent or empty means every status'
	})
	@IsOptional()
	@Transform(toList)
	@IsArray()
	@ArrayUnique()
	@IsEnum(PaymentStatus, { each: true })
	payment_status?: PaymentStatus[]
}
