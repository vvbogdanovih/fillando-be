import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
	IsEmail,
	IsEnum,
	IsIn,
	IsMongoId,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested
} from 'class-validator'
import { Type } from 'class-transformer'
import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'
import { ADS_CONSENT_STATES, type AdsConsent } from 'src/database/mongoose/schemas/order.schema'

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

/** A Google click identifier as it arrives in a landing URL: URL-safe base64 characters only. */
const CLICK_ID = /^[A-Za-z0-9_-]+$/
const CLICK_ID_MAX_LENGTH = 512

export class CreateOrderAttributionDto {
	@ApiProperty({
		enum: ADS_CONSENT_STATES,
		example: 'granted',
		description:
			"The buyer's answer in the cookie banner. Click ids, IP and browser are stored only under 'granted'."
	})
	@IsIn(ADS_CONSENT_STATES)
	consent: AdsConsent

	@ApiPropertyOptional({ example: 'Cj0KCQiA-example_gclid' })
	@IsOptional()
	@IsString()
	@MaxLength(CLICK_ID_MAX_LENGTH)
	@Matches(CLICK_ID)
	gclid?: string

	@ApiPropertyOptional({ example: '0AAAAAexample_gbraid' })
	@IsOptional()
	@IsString()
	@MaxLength(CLICK_ID_MAX_LENGTH)
	@Matches(CLICK_ID)
	gbraid?: string

	@ApiPropertyOptional({ example: '0AAAAAexample_wbraid' })
	@IsOptional()
	@IsString()
	@MaxLength(CLICK_ID_MAX_LENGTH)
	@Matches(CLICK_ID)
	wbraid?: string
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
	@ValidateIf((o: CreateOrderDto) => o.delivery_method !== DeliveryMethod.PICKUP)
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
	@ApiPropertyOptional({
		type: CreateOrderAttributionDto,
		description: 'Ad attribution of the visit; omitted by a client that predates it'
	})
	@IsOptional()
	@ValidateNested()
	@Type(() => CreateOrderAttributionDto)
	attribution?: CreateOrderAttributionDto
}
