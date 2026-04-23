import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION } from 'src/common/constants/docs/api-operation.constant'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { CreateDiscountCouponDto } from './dto/create-discount-coupon.dto'
import { GetDiscountCouponsQueryDto } from './dto/get-discount-coupons-query.dto'
import { UpdateDiscountCouponDto } from './dto/update-discount-coupon.dto'
import { ValidateDiscountCouponDto } from './dto/validate-discount-coupon.dto'
import { DiscountCouponService } from './discount-coupon.service'

@Controller(ENDPOINTS.DISCOUNT_COUPONS.BASE)
@ApiTags(ENDPOINTS.DISCOUNT_COUPONS.BASE)
export class DiscountCouponController {
	constructor(private readonly discountCouponService: DiscountCouponService) {}

	@Get(ENDPOINTS.DISCOUNT_COUPONS.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.DISCOUNT_COUPONS.GET_ALL)
	findAll(@Query() query: GetDiscountCouponsQueryDto) {
		return this.discountCouponService.findAll(query)
	}

	@Get(ENDPOINTS.DISCOUNT_COUPONS.GET_BY_ID)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.DISCOUNT_COUPONS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.discountCouponService.findById(id)
	}

	@Post(ENDPOINTS.DISCOUNT_COUPONS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.DISCOUNT_COUPONS.CREATE)
	create(@Body() dto: CreateDiscountCouponDto) {
		return this.discountCouponService.create(dto)
	}

	@Post(ENDPOINTS.DISCOUNT_COUPONS.VALIDATE)
	@ApiOperation(API_OPERATION.DISCOUNT_COUPONS.VALIDATE)
	validate(@Body() dto: ValidateDiscountCouponDto) {
		return this.discountCouponService.validateCoupon(dto.code)
	}

	@Patch(ENDPOINTS.DISCOUNT_COUPONS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.DISCOUNT_COUPONS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateDiscountCouponDto) {
		return this.discountCouponService.update(id, dto)
	}

	@Delete(ENDPOINTS.DISCOUNT_COUPONS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.DISCOUNT_COUPONS.DELETE)
	delete(@Param('id') id: string) {
		return this.discountCouponService.delete(id)
	}
}
