import { ApiProperty } from '@nestjs/swagger'
import { IsNumber, Min } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants'

export class UpdateCartItemDto {
	@ApiProperty(API_PROPERTY.CART_QUANTITY)
	@IsNumber()
	@Min(1)
	quantity: number
}
