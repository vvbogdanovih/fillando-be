import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
	IsEmail,
	IsEnum,
	IsMongoId,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	Matches,
	Min,
	ValidateIf,
	ValidateNested
} from 'class-validator'
import { Type } from 'class-transformer'
import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'

export class CreateOrderItemDto {
	@ApiProperty({ example: '664f1b2c3d4e5f6a7b8c9d0e' })
	@IsMongoId()
	variant_id: string

	@ApiProperty({ example: 2, minimum: 1 })
	@IsNumber()
	@Min(1)
	quantity: number
}

export class CreateOrderCustomerDto {
	@ApiProperty({ example: 'Іван Петренко' })
	@IsString()
	@IsNotEmpty()
	name: string

	@ApiProperty({ example: '+380991234567' })
	@IsString()
	@IsNotEmpty()
	phone: string

	@ApiProperty({ example: 'ivan@example.com' })
	@IsEmail()
	email: string
}

export class CreateOrderAddressDto {
	@ApiProperty({ example: 'Київ' })
	@IsString()
	@IsNotEmpty()
	city_name: string

	// Nova Post warehouse
	@ApiPropertyOptional({ example: 'Відділення №1: вул. Хрещатик, 1' })
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	warehouse_description?: string

	@ApiPropertyOptional({ example: 1 })
	@IsOptional()
	@IsNumber()
	warehouse_number?: number

	// Courier
	@ApiPropertyOptional({ example: 'вул. Хрещатик' })
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	street?: string

	@ApiPropertyOptional({ example: '1А' })
	@IsOptional()
	@IsString()
	@IsNotEmpty()
	building?: string

	@ApiPropertyOptional({ example: '42' })
	@IsOptional()
	@IsString()
	apartment?: string
}

export class CreateOrderDto {
	@ApiProperty({ type: [CreateOrderItemDto] })
	@ValidateNested({ each: true })
	@Type(() => CreateOrderItemDto)
	items: CreateOrderItemDto[]

	@ApiProperty({ type: CreateOrderCustomerDto })
	@ValidateNested()
	@Type(() => CreateOrderCustomerDto)
	customer: CreateOrderCustomerDto

	@ApiProperty({ enum: PaymentMethod, example: PaymentMethod.LIQPAY })
	@IsEnum(PaymentMethod)
	payment_method: PaymentMethod

	@ApiProperty({ enum: DeliveryMethod, example: DeliveryMethod.NOVA_POST })
	@IsEnum(DeliveryMethod)
	delivery_method: DeliveryMethod

	@ApiPropertyOptional({ type: CreateOrderAddressDto })
	@ValidateIf(o => o.delivery_method !== DeliveryMethod.PICKUP)
	@ValidateNested()
	@Type(() => CreateOrderAddressDto)
	delivery_address?: CreateOrderAddressDto

	@ApiPropertyOptional({ example: 'Зателефонуйте перед відправкою' })
	@IsOptional()
	@IsString()
	comment?: string

	@ApiPropertyOptional({
		example: 'AB12CD34EF',
		description: 'User-entered discount code'
	})
	@IsOptional()
	@IsString()
	@Matches(/^[A-Za-z0-9]{10}$/, {
		message: 'coupon_code must contain exactly 10 letters or digits'
	})
	coupon_code?: string
}
