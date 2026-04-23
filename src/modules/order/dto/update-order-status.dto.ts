import { ApiProperty } from '@nestjs/swagger'
import { IsEnum } from 'class-validator'
import { OrderStatus } from 'src/common/types/enums'

export class UpdateOrderStatusDto {
	@ApiProperty({ enum: OrderStatus, example: OrderStatus.CONFIRMED })
	@IsEnum(OrderStatus)
	order_status: OrderStatus
}
