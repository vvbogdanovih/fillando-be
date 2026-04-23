import { ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

export class UpdateVendorDto {
	@ApiProperty({ ...API_PROPERTY.VENDOR_NAME, required: false })
	@IsOptional()
	@IsString()
	name?: string

	@ApiProperty({ ...API_PROPERTY.SLUG, required: false })
	@IsOptional()
	@IsString()
	slug?: string
}
