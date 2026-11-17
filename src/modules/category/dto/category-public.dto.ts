import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { AttributeDefinitionDto } from './category-definitions.dto'
/** One category of a path, root first (Plan-0010 D06.4); the one class both the detail and the ancestors page use. */
export class CategoryAncestorDto {
	@ApiProperty() _id!: string
	@ApiProperty() name!: string
	@ApiProperty() slug!: string
}
export class CategorySeoDto {
	@ApiProperty({ type: String, nullable: true }) title!: string | null
	@ApiProperty({ type: String, nullable: true }) description!: string | null
	@ApiProperty({ type: String, nullable: true }) h1!: string | null
	@ApiProperty({ type: String, nullable: true }) intro_html!: string | null
	@ApiProperty({ type: String, nullable: true }) bottom_html!: string | null
}
export class PublicRequiredAttributeDto {
	@ApiProperty() key!: string
	@ApiProperty() label!: string
	@ApiProperty({ enum: ['multi-select', 'range'] }) filter_type!: string
	@ApiProperty() is_required!: boolean
	@ApiProperty({ type: String, nullable: true }) unit!: string | null
}
export class PublicGoogleCategoryDto {
	@ApiProperty() id!: number
	@ApiProperty() path!: string
}
export class CategoryPublicDto extends CategoryAncestorDto {
	@ApiProperty() revision!: number
	@ApiProperty({ type: String, nullable: true }) parent_id!: string | null
	@ApiProperty({ enum: ['group', 'product'] }) kind!: string
	@ApiProperty({ enum: ['active'] }) status!: string
	@ApiProperty({ enum: [1, 2] }) attribute_contract_version!: number
	@ApiProperty({ type: String, nullable: true }) image!: string | null
	@ApiProperty() order!: number
	@ApiProperty({
		type: [CategoryAncestorDto],
		description:
			'Root first; empty when `ancestors_paged` (read GET /categories/{id}/ancestors)'
	})
	ancestors!: CategoryAncestorDto[]
	@ApiPropertyOptional({
		enum: [true],
		description: 'Present only when the path is too long to embed (over 1 MiB, Plan-0010 D06.4)'
	})
	ancestors_paged?: true
	@ApiPropertyOptional({ description: 'Ancestors in the whole path; with `ancestors_paged`' })
	ancestors_total?: number
	@ApiProperty({ type: [AttributeDefinitionDto] })
	attribute_definitions!: AttributeDefinitionDto[]
	@ApiProperty({ type: [PublicRequiredAttributeDto] })
	required_attributes!: PublicRequiredAttributeDto[]
	@ApiProperty({ type: CategorySeoDto }) seo!: CategorySeoDto
	@ApiProperty({ type: PublicGoogleCategoryDto, nullable: true })
	google_product_category!: PublicGoogleCategoryDto | null
	@ApiPropertyOptional({ type: String, format: 'date-time' }) createdAt?: string
	@ApiPropertyOptional({ type: String, format: 'date-time' }) updatedAt?: string
}
