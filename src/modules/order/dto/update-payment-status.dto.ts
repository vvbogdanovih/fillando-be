import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEnum, IsOptional, IsString } from 'class-validator'
import { PaymentStatus } from 'src/common/types/enums'

export class UpdatePaymentStatusDto {
	@ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PAID })
	@IsEnum(PaymentStatus)
	payment_status: PaymentStatus

	@ApiPropertyOptional({ example: 'liqpay_txn_abc123' })
	@IsOptional()
	@IsString()
	payment_transaction_id?: string
}
