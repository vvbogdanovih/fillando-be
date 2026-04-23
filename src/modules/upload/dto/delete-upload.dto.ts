import { IsArray, IsNotEmpty, IsString } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { API_PROPERTY } from 'src/common/constants'

export class DeleteUploadDto {
	@ApiProperty({ type: [String], ...API_PROPERTY.S3_KEY })
	@IsArray()
	@IsNotEmpty()
	@IsString({ each: true })
	keys: string[]
}
