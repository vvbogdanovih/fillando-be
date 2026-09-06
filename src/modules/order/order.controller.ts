import {
	Body,
	Controller,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Req,
	Res,
	UseGuards
} from '@nestjs/common'
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type { Request, Response } from 'express'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Roles } from 'src/common/decorators/roles.decorator'
import { Role } from 'src/common/types/enums'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { OrderService } from './order.service'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderStatusDto } from './dto/update-order-status.dto'
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto'
import { SetTtnDto } from './dto/set-ttn.dto'
import { GetOrdersQueryDto } from './dto/get-orders-query.dto'
import { AdminUpdateOrderDto } from './dto/admin-update-order.dto'
import { GenerateInvoiceDto } from './dto/generate-invoice.dto'
import { GenerateReportDto } from './dto/generate-report.dto'
import { SendVendorEmailDto } from './dto/send-vendor-email.dto'
import { OrderListResponseDto, OrderResponseDto } from './dto/order-response.dto'
import { CreateOrderResponseDto } from './dto/create-order-response.dto'
import { OrderLookupParamsDto } from './dto/order-lookup-params.dto'
import { OrderLookupQueryDto } from './dto/order-lookup-query.dto'
import { OrderPaymentStatusResponseDto } from './dto/order-payment-status-response.dto'
import { ChangePaymentMethodDto } from './dto/change-payment-method.dto'

@Controller(ENDPOINTS.ORDERS.BASE)
@ApiTags(ENDPOINTS.ORDERS.BASE)
export class OrderController {
	constructor(private readonly orderService: OrderService) {}

	@Post(ENDPOINTS.ORDERS.CREATE)
	@UseGuards(ThrottlerGuard, OptionalJwtAuthGuard)
	@Throttle({ default: { limit: 10, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.ORDERS.CREATE)
	@ApiCreatedResponse({ type: CreateOrderResponseDto })
	create(@Body() dto: CreateOrderDto, @Req() req: Request) {
		const userId = (req.user as JWTPayload | undefined)?.id
		return this.orderService.create(dto, userId)
	}

	@Get(ENDPOINTS.ORDERS.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.GET_ALL)
	@ApiOkResponse({ type: OrderListResponseDto })
	findAll(@Query() query: GetOrdersQueryDto) {
		return this.orderService.findAll(query)
	}

	@Post(ENDPOINTS.ORDERS.GENERATE_REPORT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.GENERATE_REPORT)
	async generateReport(@Body() dto: GenerateReportDto, @Res() res: Response) {
		const { buffer, filename } = await this.orderService.generateReport(dto)
		res.set({
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Length': buffer.length.toString()
		})
		res.end(buffer)
	}

	@Get(ENDPOINTS.ORDERS.MY)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.ORDERS.MY)
	@ApiOkResponse({ type: OrderListResponseDto })
	findMyOrders(@Req() req: Request, @Query() query: GetOrdersQueryDto) {
		const userId = (req.user as JWTPayload).id
		return this.orderService.findMyOrders(userId, query)
	}

	@Get(ENDPOINTS.ORDERS.MY_BY_ID)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.ORDERS.MY_BY_ID)
	@ApiOkResponse({ type: OrderResponseDto })
	findMyOrderById(@Req() req: Request, @Param('id') id: string) {
		const userId = (req.user as JWTPayload).id
		return this.orderService.findMyOrderById(userId, id)
	}

	@Get(ENDPOINTS.ORDERS.LOOKUP)
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.ORDERS.LOOKUP)
	@ApiOkResponse({ type: OrderPaymentStatusResponseDto })
	lookupPaymentStatus(
		@Param() params: OrderLookupParamsDto,
		@Query() query: OrderLookupQueryDto
	) {
		return this.orderService.getPaymentStatusPublic(params.orderNumber, query.token)
	}

	@Get(ENDPOINTS.ORDERS.GET_BY_ID)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.GET_BY_ID)
	@ApiOkResponse({ type: OrderResponseDto })
	findById(@Param('id') id: string) {
		return this.orderService.findById(id)
	}

	// Writes, but with the same capability as the lookup: the token proves the buyer holds the
	// order's link, and switching to an offline method moves no money (TD-0009 §7).
	@Patch(ENDPOINTS.ORDERS.LOOKUP_PAYMENT_METHOD)
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 5, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.ORDERS.LOOKUP_PAYMENT_METHOD)
	@ApiOkResponse({ type: OrderPaymentStatusResponseDto })
	changePaymentMethodPublic(
		@Param() params: OrderLookupParamsDto,
		@Query() query: OrderLookupQueryDto,
		@Body() dto: ChangePaymentMethodDto
	) {
		return this.orderService.changePaymentMethodPublic(params.orderNumber, query.token, dto)
	}

	@Patch(ENDPOINTS.ORDERS.MY_PAYMENT_METHOD)
	@UseGuards(JwtAuthGuard)
	@ApiOperation(API_OPERATION.ORDERS.MY_PAYMENT_METHOD)
	@ApiOkResponse({ type: OrderResponseDto })
	changeMyPaymentMethod(
		@Req() req: Request,
		@Param('id') id: string,
		@Body() dto: ChangePaymentMethodDto
	) {
		const userId = (req.user as JWTPayload).id
		return this.orderService.changeMyPaymentMethod(userId, id, dto)
	}

	@Patch(ENDPOINTS.ORDERS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.UPDATE)
	@ApiOkResponse({ type: OrderResponseDto })
	update(@Param('id') id: string, @Body() dto: AdminUpdateOrderDto) {
		return this.orderService.update(id, dto)
	}

	@Patch(ENDPOINTS.ORDERS.UPDATE_ORDER_STATUS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.UPDATE_ORDER_STATUS)
	updateOrderStatus(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
		return this.orderService.updateOrderStatus(id, dto)
	}

	@Patch(ENDPOINTS.ORDERS.UPDATE_PAYMENT_STATUS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.UPDATE_PAYMENT_STATUS)
	updatePaymentStatus(@Param('id') id: string, @Body() dto: UpdatePaymentStatusDto) {
		return this.orderService.updatePaymentStatus(id, dto)
	}

	@Patch(ENDPOINTS.ORDERS.SET_TTN)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.SET_TTN)
	setTtn(@Param('id') id: string, @Body() dto: SetTtnDto) {
		return this.orderService.setTtn(id, dto)
	}

	@Post(ENDPOINTS.ORDERS.GENERATE_INVOICE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.GENERATE_INVOICE)
	async generateInvoice(
		@Param('id') id: string,
		@Body() dto: GenerateInvoiceDto,
		@Res() res: Response
	) {
		const { buffer, orderNumber } = await this.orderService.generateInvoice(
			id,
			dto.admin_comment
		)
		res.set({
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${orderNumber}.pdf"`,
			'Content-Length': buffer.length.toString()
		})
		res.end(buffer)
	}

	@Post(ENDPOINTS.ORDERS.SEND_VENDOR_EMAIL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.ORDERS.SEND_VENDOR_EMAIL)
	sendVendorEmail(@Param('id') id: string, @Body() dto: SendVendorEmailDto) {
		return this.orderService.sendVendorEmail(
			id,
			dto.vendor_email,
			dto.admin_comment,
			dto.attachments
		)
	}
}
