import { ApiProperty } from '@nestjs/swagger'
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs/api-property.constant'

export class CreateWholesaleInquiryDto {
	@ApiProperty(API_PROPERTY.WHOLESALE_NAME)
	@IsString()
	@IsNotEmpty()
	@MaxLength(200)
	name: string

	@ApiProperty(API_PROPERTY.WHOLESALE_PHONE)
	@IsString()
	@Matches(/^\+380\d{9}$/, { message: 'Телефон має бути у форматі +380XXXXXXXXX' })
	phone: string

	@ApiProperty(API_PROPERTY.WHOLESALE_EMAIL)
	@IsEmail()
	email: string

	@ApiProperty(API_PROPERTY.WHOLESALE_QUANTITY)
	@IsString()
	@IsNotEmpty()
	@MaxLength(500)
	quantity: string

	@ApiProperty(API_PROPERTY.WHOLESALE_COMMENT)
	@IsString()
	@IsOptional()
	@MaxLength(2000)
	comment?: string
}
