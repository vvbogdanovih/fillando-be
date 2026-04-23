import { PartialType } from '@nestjs/swagger'
import { CreateDiscountCouponDto } from './create-discount-coupon.dto'

export class UpdateDiscountCouponDto extends PartialType(CreateDiscountCouponDto) {}
