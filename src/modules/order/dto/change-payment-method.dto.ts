import { ApiProperty } from '@nestjs/swagger'
import { IsIn } from 'class-validator'
import { PaymentMethod } from 'src/common/types/enums'

/**
 * The methods a buyer may switch an unpaid order to (TD-0009 §5.3). Card is deliberately not
 * among them: moving an offline order onto LiqPay stays an admin action.
 */
export const CUSTOMER_SELECTABLE_PAYMENT_METHODS = [
	PaymentMethod.COD,
	PaymentMethod.IBAN,
	PaymentMethod.CASH
] as const

export type CustomerSelectablePaymentMethod = (typeof CUSTOMER_SELECTABLE_PAYMENT_METHODS)[number]

export class ChangePaymentMethodDto {
	@ApiProperty({ enum: CUSTOMER_SELECTABLE_PAYMENT_METHODS, example: PaymentMethod.COD })
	@IsIn(CUSTOMER_SELECTABLE_PAYMENT_METHODS)
	payment_method: CustomerSelectablePaymentMethod
}
