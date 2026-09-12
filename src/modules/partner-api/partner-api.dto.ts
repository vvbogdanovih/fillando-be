import { ApiProperty } from '@nestjs/swagger'
import { Transform } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Length } from 'class-validator'

export class CreatePartnerTokenDto {
	@ApiProperty({
		description: 'Назва партнера або інтеграції',
		maxLength: 100,
		example: 'Партнер — CRM'
	})
	@Transform(({ value }: { value: unknown }) =>
		typeof value === 'string' ? value.trim() : value
	)
	@IsString()
	@Length(1, 100)
	name: string
}
export class PartnerSkuDto {
	@ApiProperty({
		description: 'Внутрішній артикул Fillando. Точний, чутливий до регістру збіг.',
		example: 'FL-000123',
		maxLength: 100
	})
	@IsString()
	@Length(1, 100)
	sku: string
}
export class PartnerAvailabilityDto {
	@ApiProperty({ example: 'FL-000123' }) sku: string
	@ApiProperty({ example: true }) in_stock: boolean
	@ApiProperty({
		example: 12,
		minimum: 0,
		description: 'Довідкова кількість одиниць, без резервування.'
	})
	quantity: number
	@ApiProperty({
		type: String,
		format: 'date-time',
		nullable: true,
		description: 'Останнє оновлення залишку; null, якщо дата невідома.'
	})
	stock_updated_at: string | null
}
export class PartnerTokenDto {
	@ApiProperty() id: string
	@ApiProperty() name: string
	@ApiProperty() prefix: string
	@ApiProperty({ type: String, format: 'date-time' }) created_at: Date
	@ApiProperty({ type: String, format: 'date-time', nullable: true }) revoked_at: Date | null
	@ApiProperty({ type: String, format: 'date-time', nullable: true }) last_used_at: Date | null
}
export class CreatedPartnerTokenDto extends PartnerTokenDto {
	@ApiProperty({ description: 'Показується лише один раз. Збережіть у захищеному місці.' })
	token: string
}

export class BulkPartnerAvailabilityRequestDto {
	@ApiProperty({
		type: [String],
		minItems: 1,
		maxItems: 100,
		example: ['FL-000123', 'FL-000124'],
		description:
			'Точні внутрішні артикули Fillando, кожен від 1 до 100 символів. Регістр має значення.'
	})
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(100)
	@IsString({ each: true })
	@Length(1, 100, { each: true })
	skus: string[]
}
export class BulkPartnerAvailabilityResponseDto {
	@ApiProperty({
		type: [PartnerAvailabilityDto],
		description: 'Знайдені активні товари, включно з нульовими залишками.'
	})
	items: PartnerAvailabilityDto[]
	@ApiProperty({
		type: [String],
		example: ['FL-000124'],
		description: 'Невідомі або неактивні артикули.'
	})
	not_found: string[]
}
