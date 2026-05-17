import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength } from 'class-validator'

export class GenerateInvoiceDto {
	@ApiPropertyOptional({ example: 'Перевірено адміном' })
	@IsOptional()
	@IsString()
	@MaxLength(1000)
	admin_comment?: string
}
