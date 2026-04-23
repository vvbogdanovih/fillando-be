import { ApiProperty } from '@nestjs/swagger'
import { IsMongoId, IsNumber, Min } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants'

export class AddCartItemDto {
	@ApiProperty(API_PROPERTY.CART_VARIANT_ID)
	@IsMongoId()
	variant_id: string

	@ApiProperty(API_PROPERTY.CART_QUANTITY)
	@IsNumber()
	@Min(1)
	quantity: number
}
