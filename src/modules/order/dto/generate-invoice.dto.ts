import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator'
import { InvoiceAudience } from 'src/common/types/enums'

export class GenerateInvoiceDto {
	@ApiPropertyOptional({ example: 'Перевірено адміном' })
	@IsOptional()
	@IsString()
	@MaxLength(1000)
	admin_comment?: string

	@ApiPropertyOptional({
		enum: InvoiceAudience,
		default: InvoiceAudience.INTERNAL,
		description: '`customer` omits the supplier article (Vendor SKU) column.'
	})
	@IsOptional()
	@IsEnum(InvoiceAudience)
	audience?: InvoiceAudience
}
