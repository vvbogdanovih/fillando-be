import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	ParseEnumPipe,
	Patch,
	Post,
	UseGuards
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Roles } from 'src/common/decorators/roles.decorator'
import { PaymentProvider, Role } from 'src/common/types/enums'
import { PaymentProvidersService } from './payment-providers.service'
import { CreatePaymentProviderDto } from './dto/create-payment-provider.dto'
import { UpdatePaymentProviderDto } from './dto/update-payment-provider.dto'

@Controller(ENDPOINTS.PAYMENT_PROVIDERS.BASE)
@ApiTags(ENDPOINTS.PAYMENT_PROVIDERS.BASE)
export class PaymentProvidersController {
	constructor(private readonly paymentProvidersService: PaymentProvidersService) {}

	@Get(ENDPOINTS.PAYMENT_PROVIDERS.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.GET_ALL)
	findAll() {
		return this.paymentProvidersService.findAll()
	}

	@Get(ENDPOINTS.PAYMENT_PROVIDERS.GET_ACTIVE)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.GET_ACTIVE)
	findActive(@Param('provider', new ParseEnumPipe(PaymentProvider)) provider: PaymentProvider) {
		return this.paymentProvidersService.findActiveByProvider(provider)
	}

	@Get(ENDPOINTS.PAYMENT_PROVIDERS.GET_BY_ID)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.paymentProvidersService.findById(id)
	}

	@Post(ENDPOINTS.PAYMENT_PROVIDERS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.CREATE)
	create(@Body() dto: CreatePaymentProviderDto) {
		return this.paymentProvidersService.create(dto)
	}

	@Patch(ENDPOINTS.PAYMENT_PROVIDERS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdatePaymentProviderDto) {
		return this.paymentProvidersService.update(id, dto)
	}

	@Delete(ENDPOINTS.PAYMENT_PROVIDERS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.DELETE)
	delete(@Param('id') id: string) {
		return this.paymentProvidersService.delete(id)
	}

	@Patch(ENDPOINTS.PAYMENT_PROVIDERS.ACTIVATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PAYMENT_PROVIDERS.ACTIVATE)
	activate(@Param('id') id: string) {
		return this.paymentProvidersService.activate(id)
	}
}
