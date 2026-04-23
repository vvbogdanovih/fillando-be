import { ApiProperty } from '@nestjs/swagger'
import { IsArray, IsString } from 'class-validator'

export class SetVariantImagesDto {
	@ApiProperty({ example: ['https://cdn.example.com/img.webp'] })
	@IsArray()
	@IsString({ each: true })
	images: string[]
}
