import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator'

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
}
