import { PartialType } from '@nestjs/mapped-types'
import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator'
import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'
import {
	CreateOrderAddressDto,
	CreateOrderCustomerDto,
	CreateOrderItemDto
} from './create-order.dto'

class UpdateOrderCustomerDto extends PartialType(CreateOrderCustomerDto) {}
class UpdateOrderAddressDto extends PartialType(CreateOrderAddressDto) {}

export class AdminUpdateOrderDto {
	@ApiPropertyOptional({ type: [CreateOrderItemDto] })
	@IsOptional()
	@ValidateNested({ each: true })
	@Type(() => CreateOrderItemDto)
	items?: CreateOrderItemDto[]

	@ApiPropertyOptional({ type: UpdateOrderCustomerDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => UpdateOrderCustomerDto)
	customer?: UpdateOrderCustomerDto

	@ApiPropertyOptional({ enum: PaymentMethod, example: PaymentMethod.LIQPAY })
	@IsOptional()
	@IsEnum(PaymentMethod)
	payment_method?: PaymentMethod

	@ApiPropertyOptional({ enum: DeliveryMethod, example: DeliveryMethod.NOVA_POST })
	@IsOptional()
	@IsEnum(DeliveryMethod)
	delivery_method?: DeliveryMethod

	@ApiPropertyOptional({ type: UpdateOrderAddressDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => UpdateOrderAddressDto)
	delivery_address?: UpdateOrderAddressDto

	@ApiPropertyOptional({ example: 'Зателефонуйте за 30 хв до доставки' })
	@IsOptional()
	@IsString()
	comment?: string
}
