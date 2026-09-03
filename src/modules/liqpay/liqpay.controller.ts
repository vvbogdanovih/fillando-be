import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { LiqpayService } from './liqpay.service'
import { InitLiqpayCheckoutDto } from './dto/init-liqpay-checkout.dto'
import { LiqpayCallbackDto } from './dto/liqpay-callback.dto'

@Controller(ENDPOINTS.LIQPAY.BASE)
@ApiTags(ENDPOINTS.LIQPAY.BASE)
export class LiqpayController {
	constructor(private readonly liqpayService: LiqpayService) {}

	@Post(ENDPOINTS.LIQPAY.CHECKOUT)
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.LIQPAY.CHECKOUT)
	initCheckout(@Body() dto: InitLiqpayCheckoutDto) {
		return this.liqpayService.buildCheckout(dto.order_number)
	}

	@Post(ENDPOINTS.LIQPAY.CALLBACK)
	@HttpCode(200)
	@ApiOperation(API_OPERATION.LIQPAY.CALLBACK)
	async callback(@Body() dto: LiqpayCallbackDto) {
		await this.liqpayService.handleCallback(dto.data, dto.signature)
		return { status: 'ok' }
	}
}
