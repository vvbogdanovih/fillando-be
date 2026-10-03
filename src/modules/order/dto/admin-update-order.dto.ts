import { PartialType } from '@nestjs/mapped-types'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	ArrayNotEmpty,
	IsArray,
	IsEnum,
	IsNumber,
	IsOptional,
	IsString,
	MaxLength,
	Min,
	MinLength,
	ValidateNested
} from 'class-validator'
import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'
import {
	CreateOrderAddressDto,
	CreateOrderCustomerDto,
	CreateOrderItemDto
} from './create-order.dto'

class UpdateOrderCustomerDto extends PartialType(CreateOrderCustomerDto) {}
class UpdateOrderAddressDto extends PartialType(CreateOrderAddressDto) {}

export class ManualDiscountDto {
	@ApiProperty({ example: 50, minimum: 0.01, description: 'Fixed discount in UAH' })
	@IsNumber({ maxDecimalPlaces: 2 })
	@Min(0.01)
	amount: number

	@ApiProperty({ example: 'Клієнт попросив знижку по телефону', maxLength: 300 })
	@IsString()
	@MinLength(1)
	@MaxLength(300)
	reason: string
}

export class AdminUpdateOrderDto {
	/** Full replacement of the order items — omitted items are removed from the order. */
	@ApiPropertyOptional({ type: [CreateOrderItemDto], minItems: 1 })
	@IsOptional()
	@IsArray()
	@ArrayNotEmpty({ message: 'items must contain at least one product' })
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

	/**
	 * Admin discount in UAH on top of the coupon; `null` removes it. Refused once the order is
	 * paid — `total_price` is what LiqPay is checked against and what the buyer was charged.
	 */
	@ApiPropertyOptional({ type: ManualDiscountDto, nullable: true })
	@IsOptional()
	@ValidateNested()
	@Type(() => ManualDiscountDto)
	manual_discount?: ManualDiscountDto | null

	@ApiPropertyOptional({ example: 'Зателефонуйте за 30 хв до доставки' })
	@IsOptional()
	@IsString()
	comment?: string
}
