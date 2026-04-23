import { ApiProperty } from '@nestjs/swagger'
import { IsString } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

export class CreateVendorDto {
	@ApiProperty(API_PROPERTY.VENDOR_NAME)
	@IsString()
	name: string

	@ApiProperty(API_PROPERTY.SLUG)
	@IsString()
	slug: string
}
