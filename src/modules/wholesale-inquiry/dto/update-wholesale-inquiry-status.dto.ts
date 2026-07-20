import { ApiProperty } from '@nestjs/swagger'
import { IsEnum } from 'class-validator'
import { WholesaleInquiryStatus } from 'src/common/types/enums'

export class UpdateWholesaleInquiryStatusDto {
	@ApiProperty({ enum: WholesaleInquiryStatus })
	@IsEnum(WholesaleInquiryStatus)
	status: WholesaleInquiryStatus
}
