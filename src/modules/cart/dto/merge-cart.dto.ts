import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsMongoId, IsNumber, Min, ValidateNested } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants'

class MergeCartItemDto {
	@ApiProperty(API_PROPERTY.CART_VARIANT_ID)
	@IsMongoId()
	variant_id: string

	@ApiProperty(API_PROPERTY.CART_QUANTITY)
	@IsNumber()
	@Min(1)
	quantity: number
}

export class MergeCartDto {
	@ApiProperty({ type: [MergeCartItemDto] })
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => MergeCartItemDto)
	items: MergeCartItemDto[]
}
