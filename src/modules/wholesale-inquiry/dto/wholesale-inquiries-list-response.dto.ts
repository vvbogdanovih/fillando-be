import { ApiProperty } from '@nestjs/swagger'
import { API_PROPERTY } from 'src/common/constants/docs/api-property.constant'
import { WholesaleInquiryStatus } from 'src/common/types/enums'

export class WholesaleInquiryItemDto {
	@ApiProperty({ example: '664f1b2c3d4e5f6a7b8c9d0e' })
	id: string

	@ApiProperty(API_PROPERTY.WHOLESALE_NAME)
	name: string

	@ApiProperty(API_PROPERTY.WHOLESALE_PHONE)
	phone: string

	@ApiProperty(API_PROPERTY.WHOLESALE_EMAIL)
	email: string

	@ApiProperty(API_PROPERTY.WHOLESALE_QUANTITY)
	quantity: string

	@ApiProperty({ ...API_PROPERTY.WHOLESALE_COMMENT, nullable: true })
	comment: string | null

	@ApiProperty({ enum: WholesaleInquiryStatus })
	status: WholesaleInquiryStatus

	@ApiProperty()
	createdAt: Date
}

export class WholesaleInquiriesListResponseDto {
	@ApiProperty({ type: [WholesaleInquiryItemDto] })
	items: WholesaleInquiryItemDto[]

	@ApiProperty({ example: 42 })
	total: number

	@ApiProperty({ example: 1 })
	page: number

	@ApiProperty({ example: 20 })
	limit: number
}
