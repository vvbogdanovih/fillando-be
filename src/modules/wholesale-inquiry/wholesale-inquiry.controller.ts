import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { CreateWholesaleInquiryDto } from './dto/create-wholesale-inquiry.dto'
import { GetWholesaleInquiriesQueryDto } from './dto/get-wholesale-inquiries-query.dto'
import { UpdateWholesaleInquiryStatusDto } from './dto/update-wholesale-inquiry-status.dto'
import { WholesaleInquiriesListResponseDto } from './dto/wholesale-inquiries-list-response.dto'
import { WholesaleInquiryService } from './wholesale-inquiry.service'

@Controller(ENDPOINTS.WHOLESALE_INQUIRIES.BASE)
@ApiTags(ENDPOINTS.WHOLESALE_INQUIRIES.BASE)
export class WholesaleInquiryController {
	constructor(private readonly wholesaleInquiryService: WholesaleInquiryService) {}

	@Post(ENDPOINTS.WHOLESALE_INQUIRIES.CREATE)
	@ApiOperation(API_OPERATION.WHOLESALE_INQUIRIES.CREATE)
	create(@Body() dto: CreateWholesaleInquiryDto) {
		return this.wholesaleInquiryService.create(dto)
	}

	@Get(ENDPOINTS.WHOLESALE_INQUIRIES.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.WHOLESALE_INQUIRIES.GET_ALL)
	@ApiOkResponse({ type: WholesaleInquiriesListResponseDto })
	findAll(@Query() query: GetWholesaleInquiriesQueryDto) {
		return this.wholesaleInquiryService.findAll(query)
	}

	@Patch(ENDPOINTS.WHOLESALE_INQUIRIES.UPDATE_STATUS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.WHOLESALE_INQUIRIES.UPDATE_STATUS)
	updateStatus(@Param('id') id: string, @Body() dto: UpdateWholesaleInquiryStatusDto) {
		return this.wholesaleInquiryService.updateStatus(id, dto)
	}
}
