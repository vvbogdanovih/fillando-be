import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'

export class InitLiqpayCheckoutDto {
	@ApiProperty({
		example: 'FO-0000001',
		description: 'Order number of an existing PENDING order'
	})
	@IsString()
	@Matches(/^FO-\d{7}$/, { message: 'order_number must match FO-XXXXXXX' })
	order_number: string
}
