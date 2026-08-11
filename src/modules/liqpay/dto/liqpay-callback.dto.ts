import { ApiProperty } from '@nestjs/swagger'
import { IsString } from 'class-validator'

export class LiqpayCallbackDto {
	@ApiProperty({ description: 'Base64-encoded LiqPay payload' })
	@IsString()
	data: string

	@ApiProperty({ description: 'LiqPay signature of the payload' })
	@IsString()
	signature: string
}
