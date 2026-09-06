import { ApiProperty } from '@nestjs/swagger'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'

export class OrderPaymentStatusResponseDto {
	@ApiProperty({ example: 'FO-0000123' })
	order_number: string

	@ApiProperty({ enum: PaymentMethod })
	payment_method: PaymentMethod

	@ApiProperty({ enum: PaymentStatus })
	payment_status: PaymentStatus

	@ApiProperty({ example: 2338.2 })
	total_price: number

	@ApiProperty({ enum: OrderStatus })
	order_status: OrderStatus

	/** Decides which offline methods the storefront may offer (COD needs a carrier). */
	@ApiProperty({ enum: DeliveryMethod })
	delivery_method: DeliveryMethod

	/**
	 * True while the payment is PENDING or FAILED and the order is NEW or CONFIRMED — computed
	 * here so the storefront never has to mirror the rule (TD-0009 §5.3).
	 */
	@ApiProperty({ example: true })
	can_change_payment_method: boolean

	/**
	 * Seconds until a new LiqPay checkout may be opened: `null` when no card session was ever
	 * opened (pay at once), `0` when it may be opened now, otherwise the remaining cooldown —
	 * the same number a refused `POST /liqpay/checkout` carries (TD-0009 §5.4.3).
	 */
	@ApiProperty({ example: 0, nullable: true })
	liqpay_retry_after_seconds: number | null
}
