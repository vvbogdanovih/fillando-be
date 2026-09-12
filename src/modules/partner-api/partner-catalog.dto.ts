import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsInt, IsMongoId, IsOptional, IsString, Length, Max, Min } from 'class-validator'
import { BulkPartnerAvailabilityRequestDto, PartnerAvailabilityDto } from './partner-api.dto'

export class PartnerCategoryDto {
	@ApiProperty() id: string
	@ApiProperty() name: string
	@ApiProperty() slug: string
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'Категорії плоскі; наразі завжди null.'
	})
	parent_id: null
	@ApiProperty({
		minimum: 0,
		description: 'Кількість активних артикулів, доступних для вивантаження.'
	})
	sku_count: number
}
export class PartnerSkuRequestDto {
	@ApiPropertyOptional({
		type: String,
		nullable: true,
		example: null,
		description: 'ID категорії. null або відсутність поля — весь каталог.'
	})
	@IsOptional()
	@IsMongoId()
	category_id?: string | null
	@ApiPropertyOptional({
		type: String,
		nullable: true,
		example: null,
		description:
			'next_cursor попередньої сторінки; null або відсутність поля — перша сторінка.',
		maxLength: 1024
	})
	@IsOptional()
	@IsString()
	@Length(1, 1024)
	cursor?: string | null
	@ApiPropertyOptional({ type: 'integer', default: 100, minimum: 1, maximum: 100 })
	@IsInt()
	@Min(1)
	@Max(100)
	limit: number = 100
}
export class PartnerSkuPageDto {
	@ApiProperty({ type: [String] }) items: string[]
	@ApiProperty({ type: String, nullable: true, description: 'null означає кінець списку.' })
	next_cursor: string | null
}
export class PartnerProductLookupDto extends BulkPartnerAvailabilityRequestDto {}
export class PartnerAttributeDto {
	@ApiProperty() key: string
	@ApiProperty() label: string
	@ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }) value:
		| string
		| number
		| boolean
}
export class PartnerProductCategoryDto {
	@ApiProperty() id: string
	@ApiProperty() name: string
	@ApiProperty() slug: string
}
export class PartnerVariantDto {
	@ApiProperty() key: string
	@ApiProperty() label: string
	@ApiProperty() value: string
}
export class PartnerProductDto {
	@ApiProperty({
		example: 599.5,
		description:
			'Поточна роздрібна ціна одиниці товару у гривнях. Довідкова; не фіксується до оформлення замовлення.'
	})
	price: number
	@ApiProperty({ enum: ['UAH'], example: 'UAH' })
	currency: 'UAH'

	@ApiProperty() sku: string
	@ApiProperty() name: string
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'HTML-опис товару, null якщо відсутній.'
	})
	description_html: string | null
	@ApiProperty({ type: PartnerProductCategoryDto }) category: PartnerProductCategoryDto
	@ApiProperty({ type: [PartnerAttributeDto] }) attributes: PartnerAttributeDto[]
	@ApiProperty({
		type: PartnerVariantDto,
		nullable: true,
		description: 'Ознака конкретного варіанта, наприклад колір.'
	})
	variant: PartnerVariantDto | null
	@ApiProperty({ type: [String], description: 'URL зображень у порядку відображення.' })
	images: string[]
	@ApiProperty({ format: 'uri' }) url: string
	@ApiProperty({
		type: Number,
		nullable: true,
		description: 'Вага для доставки в грамах; null якщо невідома.'
	})
	weight_g: number | null
	@ApiProperty({ type: PartnerAvailabilityDto }) availability: PartnerAvailabilityDto
}
export class PartnerProductLookupResponseDto {
	@ApiProperty({ type: [PartnerProductDto] }) items: PartnerProductDto[]
	@ApiProperty({
		type: [String],
		description: 'Невідомі, неактивні або недоступні для вивантаження артикули.'
	})
	not_found: string[]
}
