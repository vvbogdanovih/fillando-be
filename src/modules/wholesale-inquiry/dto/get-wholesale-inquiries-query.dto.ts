import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsEnum, IsNumber, IsOptional, Min } from 'class-validator'
import { Type } from 'class-transformer'
import { WholesaleInquiryStatus } from 'src/common/types/enums'

export class GetWholesaleInquiriesQueryDto {
	@ApiPropertyOptional({ enum: WholesaleInquiryStatus })
	@IsOptional()
	@IsEnum(WholesaleInquiryStatus)
	status?: WholesaleInquiryStatus

	@ApiPropertyOptional({ default: 1, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	page?: number = 1

	@ApiPropertyOptional({ default: 20, minimum: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	limit?: number = 20
}
