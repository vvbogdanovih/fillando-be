import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { DiscountCouponRepository } from 'src/database/mongoose/repositories/discount-coupon.repository'
import {
	DiscountCoupon,
	DiscountCouponSchema
} from 'src/database/mongoose/schemas/discount-coupon.schema'
import { NumbersModule } from '../numbers/numbers.module'
import { DiscountCouponController } from './discount-coupon.controller'
import { DiscountCouponService } from './discount-coupon.service'

@Module({
	imports: [
		MongooseModule.forFeature([{ name: DiscountCoupon.name, schema: DiscountCouponSchema }]),
		NumbersModule
	],
	controllers: [DiscountCouponController],
	providers: [DiscountCouponService, DiscountCouponRepository],
	exports: [DiscountCouponService, DiscountCouponRepository]
})
export class DiscountCouponModule {}
