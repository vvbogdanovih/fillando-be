import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { PartnerApiService } from './partner-api.service'
import {
	PartnerApiGuard,
	PartnerIpThrottlerGuard,
	PartnerTokenThrottlerGuard
} from './partner-api.guard'
import {
	BulkPartnerAvailabilityRequestDto,
	BulkPartnerAvailabilityResponseDto,
	PartnerAvailabilityDto,
	PartnerSkuDto
} from './partner-api.dto'
@Controller(ENDPOINTS.PARTNER_API.BASE)
@ApiTags('Наявність товарів')
@ApiBearerAuth('partner-token')
@UseGuards(PartnerIpThrottlerGuard, PartnerApiGuard, PartnerTokenThrottlerGuard)
export class PartnerApiController {
	constructor(private readonly service: PartnerApiService) {}
	@Post(ENDPOINTS.PARTNER_API.BULK_AVAILABILITY)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.BULK_AVAILABILITY)
	@ApiOkResponse({ type: BulkPartnerAvailabilityResponseDto })
	@ApiResponse({
		status: 400,
		description: 'Потрібен масив від 1 до 100 артикулів, кожен — рядок від 1 до 100 символів.'
	})
	@ApiResponse({ status: 401, description: 'Токен відсутній, невірний або відкликаний' })
	@ApiResponse({
		status: 429,
		description:
			'Спільний ліміт партнерських запитів перевищено. Повторіть через Retry-After секунд.'
	})
	bulkAvailability(@Body() body: BulkPartnerAvailabilityRequestDto) {
		return this.service.bulkAvailability(body.skus)
	}

	@Get(ENDPOINTS.PARTNER_API.AVAILABILITY)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.AVAILABILITY)
	@ApiOkResponse({ type: PartnerAvailabilityDto })
	@ApiResponse({ status: 400, description: 'Некоректний артикул' })
	@ApiResponse({ status: 401, description: 'Токен відсутній, невірний або відкликаний' })
	@ApiResponse({ status: 404, description: 'Товар не знайдений або неактивний' })
	@ApiResponse({
		status: 429,
		description: 'Ліміт запитів перевищено. Повторіть через Retry-After секунд.'
	})
	availability(@Param() params: PartnerSkuDto) {
		return this.service.availability(params.sku)
	}
}
