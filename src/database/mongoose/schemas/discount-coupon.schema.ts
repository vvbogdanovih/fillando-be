import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ collection: 'discount_coupons', timestamps: true })
export class DiscountCoupon {
	@Prop({ required: true, unique: true, trim: true, match: /^DIS-\d{7}$/ })
	number: string

	@Prop({
		required: true,
		unique: true,
		uppercase: true,
		trim: true,
		match: /^[A-Z0-9]{10}$/
	})
	code: string

	@Prop({ required: true, min: 0, max: 100 })
	discount_percent: number

	@Prop({ required: true })
	valid_until: Date

	@Prop({ default: true })
	is_active: boolean
}

export const DiscountCouponSchema = SchemaFactory.createForClass(DiscountCoupon)
DiscountCouponSchema.index({ number: 1 }, { unique: true })
DiscountCouponSchema.index({ code: 1 }, { unique: true })
DiscountCouponSchema.index({ valid_until: 1, is_active: 1 })
export type DiscountCouponDocument = HydratedDocument<DiscountCoupon>
