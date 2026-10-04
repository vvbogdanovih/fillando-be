import { ApiProperty } from '@nestjs/swagger'
import { IsIn } from 'class-validator'
import { OrderStatus } from 'src/common/types/enums'
import { ADMIN_SETTABLE_ORDER_STATUSES } from '../helpers/order-status.rules'

export class UpdateOrderStatusDto {
	/**
	 * `COMPLETED` is never set by hand — it follows from DELIVERED + PAID — and `PROCESSING` is
	 * retired (TD-0011). Whether the move is allowed from the current status is checked by the
	 * service (409 `INVALID_STATUS_TRANSITION`).
	 */
	@ApiProperty({ enum: ADMIN_SETTABLE_ORDER_STATUSES, example: OrderStatus.CONFIRMED })
	@IsIn(ADMIN_SETTABLE_ORDER_STATUSES)
	order_status: OrderStatus
}
