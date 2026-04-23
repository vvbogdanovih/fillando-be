import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { API_OPERATION } from 'src/common/constants/docs/api-operation.constant'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { PaymentDetailsService } from './payment-details.service'
import { CreatePaymentDetailsDto } from './dto/create-payment-details.dto'
import { UpdatePaymentDetailsDto } from './dto/update-payment-details.dto'

@Controller(ENDPOINTS.PAYMENT_DETAILS.BASE)
@ApiTags(ENDPOINTS.PAYMENT_DETAILS.BASE)
export class PaymentDetailsController {
	constructor(private readonly paymentDetailsService: PaymentDetailsService) {}

	@Get(ENDPOINTS.PAYMENT_DETAILS.GET_ALL)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.GET_ALL)
	findAll() {
		return this.paymentDetailsService.findAll()
	}

	@Get(ENDPOINTS.PAYMENT_DETAILS.GET_ACTIVE)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.GET_ACTIVE)
	findActive() {
		return this.paymentDetailsService.findActive()
	}

	@Get(ENDPOINTS.PAYMENT_DETAILS.GET_BY_ID)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.paymentDetailsService.findById(id)
	}

	@Post(ENDPOINTS.PAYMENT_DETAILS.CREATE)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.CREATE)
	create(@Body() dto: CreatePaymentDetailsDto) {
		return this.paymentDetailsService.create(dto)
	}

	@Patch(ENDPOINTS.PAYMENT_DETAILS.UPDATE)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdatePaymentDetailsDto) {
		return this.paymentDetailsService.update(id, dto)
	}

	@Delete(ENDPOINTS.PAYMENT_DETAILS.DELETE)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.DELETE)
	delete(@Param('id') id: string) {
		return this.paymentDetailsService.delete(id)
	}

	@Patch(ENDPOINTS.PAYMENT_DETAILS.ACTIVATE)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.PAYMENT_DETAILS.ACTIVATE)
	activate(@Param('id') id: string) {
		return this.paymentDetailsService.activate(id)
	}
}
