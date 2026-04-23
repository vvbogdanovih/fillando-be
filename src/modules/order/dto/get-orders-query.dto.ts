import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsEnum, IsNumber, IsOptional, Min } from 'class-validator'
import { Type } from 'class-transformer'
import { OrderStatus, PaymentStatus } from 'src/common/types/enums'

export class GetOrdersQueryDto {
	@ApiPropertyOptional({ enum: OrderStatus })
	@IsOptional()
	@IsEnum(OrderStatus)
	order_status?: OrderStatus

	@ApiPropertyOptional({ enum: PaymentStatus })
	@IsOptional()
	@IsEnum(PaymentStatus)
	payment_status?: PaymentStatus

	@ApiPropertyOptional({ default: 1, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	page?: number = 1

	@ApiPropertyOptional({ default: 20, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	limit?: number = 20
}
