import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'

export class OrderLookupParamsDto {
	@ApiProperty({ example: 'FO-0000123', description: 'Order number in FO-XXXXXXX format' })
	@IsString()
	@Matches(/^FO-\d{7}$/, { message: 'orderNumber must match FO-XXXXXXX' })
	orderNumber: string
}
