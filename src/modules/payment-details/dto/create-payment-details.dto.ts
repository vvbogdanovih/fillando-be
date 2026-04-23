import { ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs/api-property.constant'

export class CreatePaymentDetailsDto {
	@ApiProperty(API_PROPERTY.PAYMENT_LAST_NAME)
	@IsString()
	last_name: string

	@ApiProperty(API_PROPERTY.PAYMENT_FIRST_NAME)
	@IsString()
	first_name: string

	@ApiProperty(API_PROPERTY.PAYMENT_MIDDLE_NAME)
	@IsString()
	@IsOptional()
	middle_name?: string

	@ApiProperty(API_PROPERTY.PAYMENT_IBAN)
	@IsString()
	iban: string

	@ApiProperty(API_PROPERTY.PAYMENT_EDRPOU)
	@IsString()
	edrpou: string

	@ApiProperty(API_PROPERTY.PAYMENT_BANK_NAME)
	@IsString()
	bank_name: string
}
