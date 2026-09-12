import { Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common'
import {
	ApiBody,
	ApiBearerAuth,
	ApiOkResponse,
	ApiOperation,
	ApiResponse,
	ApiTags
} from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import {
	PartnerApiGuard,
	PartnerIpThrottlerGuard,
	PartnerTokenThrottlerGuard
} from './partner-api.guard'
import { PartnerCatalogService } from './partner-catalog.service'
import {
	PartnerCategoryDto,
	PartnerProductLookupDto,
	PartnerProductLookupResponseDto,
	PartnerSkuPageDto,
	PartnerSkuRequestDto
} from './partner-catalog.dto'
@Controller(ENDPOINTS.PARTNER_API.BASE)
@ApiTags('Каталог')
@ApiBearerAuth('partner-token')
@UseGuards(PartnerIpThrottlerGuard, PartnerApiGuard, PartnerTokenThrottlerGuard)
@ApiResponse({ status: 401, description: 'Токен відсутній, невірний або відкликаний' })
@ApiResponse({
	status: 429,
	description: 'Спільний ліміт партнерського API. Повторіть через Retry-After секунд.'
})
export class PartnerCatalogController {
	constructor(private readonly service: PartnerCatalogService) {}
	@Post(ENDPOINTS.PARTNER_API.CATEGORIES)
	@HttpCode(200)
	@ApiBody({
		schema: { type: 'object', example: {} },
		examples: { all: { summary: 'Готовий запит — усі категорії', value: {} } },
		description: 'Порожній JSON-об’єкт {} — усі категорії.'
	})
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.CATEGORIES)
	@ApiOkResponse({ type: PartnerCategoryDto, isArray: true })
	categories() {
		return this.service.categories()
	}
	@Post(ENDPOINTS.PARTNER_API.SKUS)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.SKUS_BODY)
	@ApiBody({
		type: PartnerSkuRequestDto,
		description:
			'Готовий запит першої сторінки: category_id=null — усі категорії, cursor=null — початок списку. Для фільтрації замініть category_id на id із POST /partner/v1/categories; для наступної сторінки замініть cursor на отриманий next_cursor.',
		examples: {
			first_page: {
				summary: 'Готовий запит — перша сторінка всього каталогу',
				value: { category_id: null, cursor: null, limit: 100 }
			}
		}
	})
	@ApiOkResponse({ type: PartnerSkuPageDto })
	@ApiResponse({
		status: 400,
		description: 'Некоректні category_id, cursor або limit у JSON-тілі'
	})
	@ApiResponse({ status: 404, description: 'Категорія не існує' })
	skusFromBody(@Body() body: PartnerSkuRequestDto) {
		return this.service.skus(body)
	}
	@Post(ENDPOINTS.PARTNER_API.LOOKUP)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.LOOKUP)
	@ApiOkResponse({ type: PartnerProductLookupResponseDto })
	@ApiResponse({
		status: 400,
		description: 'Потрібен масив від 1 до 100 артикулів, кожен від 1 до 100 символів'
	})
	lookup(@Body() body: PartnerProductLookupDto) {
		return this.service.lookup(body.skus)
	}
}
