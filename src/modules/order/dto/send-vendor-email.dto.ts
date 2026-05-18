import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
	IsArray,
	IsEmail,
	IsNotEmpty,
	IsOptional,
	IsString,
	MaxLength,
	ValidateNested
} from 'class-validator'

class AttachmentDto {
	@ApiProperty({ example: 'invoice.pdf' })
	@IsString()
	@IsNotEmpty()
	filename: string

	@ApiProperty({ description: 'Base64-encoded file content' })
	@IsString()
	@IsNotEmpty()
	content: string
}

export class SendVendorEmailDto {
	@ApiProperty({ example: 'vendor@example.com' })
	@IsEmail()
	@IsNotEmpty()
	vendor_email: string

	@ApiPropertyOptional({ example: 'Перевірено адміном' })
	@IsOptional()
	@IsString()
	@MaxLength(1000)
	admin_comment?: string

	@ApiPropertyOptional({ type: [AttachmentDto] })
	@IsOptional()
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => AttachmentDto)
	attachments?: AttachmentDto[]
}
