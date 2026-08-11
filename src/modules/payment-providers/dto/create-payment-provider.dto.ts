import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator'
import { PaymentProvider } from 'src/common/types/enums'
import { API_PROPERTY } from 'src/common/constants/docs/api-property.constant'

export class CreatePaymentProviderDto {
	@ApiProperty({ enum: PaymentProvider, example: PaymentProvider.LIQPAY })
	@IsEnum(PaymentProvider)
	provider: PaymentProvider

	@ApiProperty(API_PROPERTY.PAYMENT_PROVIDER_LABEL)
	@IsString()
	label: string

	@ApiProperty(API_PROPERTY.PAYMENT_PROVIDER_PUBLIC_KEY)
	@IsString()
	public_key: string

	@ApiProperty(API_PROPERTY.PAYMENT_PROVIDER_PRIVATE_KEY)
	@IsString()
	private_key: string

	@ApiProperty(API_PROPERTY.PAYMENT_PROVIDER_SANDBOX)
	@IsBoolean()
	@IsOptional()
	sandbox?: boolean
}
