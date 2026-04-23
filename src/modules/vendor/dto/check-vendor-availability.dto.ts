import { ApiProperty } from '@nestjs/swagger'
import { IsString } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants'

export class CheckVendorAvailabilityDto {
	@ApiProperty(API_PROPERTY.SLUG)
	@IsString()
	slug: string
}
