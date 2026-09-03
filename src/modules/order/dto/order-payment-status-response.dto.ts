import { ApiProperty } from '@nestjs/swagger'
import { PaymentMethod, PaymentStatus } from 'src/common/types/enums'

export class OrderPaymentStatusResponseDto {
	@ApiProperty({ example: 'FO-0000123' })
	order_number: string

	@ApiProperty({ enum: PaymentMethod })
	payment_method: PaymentMethod

	@ApiProperty({ enum: PaymentStatus })
	payment_status: PaymentStatus

	@ApiProperty({ example: 2338.2 })
	total_price: number
}
