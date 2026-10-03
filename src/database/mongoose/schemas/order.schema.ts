import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'

@Schema({ _id: false })
export class OrderItem {
	@Prop({ type: Types.ObjectId, ref: 'ProductVariant', required: true })
	variant_id: Types.ObjectId

	@Prop({ type: Types.ObjectId, ref: 'Product', required: true })
	product_id: Types.ObjectId

	@Prop({ required: true })
	name: string

	@Prop({ required: true })
	sku: string

	@Prop({ type: String, default: null })
	vendor_sku: string | null

	@Prop({ required: true })
	price: number

	@Prop({ required: true, min: 1 })
	quantity: number

	@Prop({ type: String, default: null })
	image: string | null
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem)

@Schema({ _id: false })
export class CustomerSnapshot {
	@Prop({ required: true })
	name: string

	@Prop({ required: true })
	phone: string

	@Prop({ required: true })
	email: string
}

export const CustomerSnapshotSchema = SchemaFactory.createForClass(CustomerSnapshot)

@Schema({ _id: false })
export class DeliveryAddress {
	@Prop({ required: true })
	city_name: string

	// Nova Post warehouse fields
	@Prop({ type: String, default: null })
	warehouse_description: string | null

	@Prop({ type: Number, default: null })
	warehouse_number: number | null

	// Courier fields
	@Prop({ type: String, default: null })
	street: string | null

	@Prop({ type: String, default: null })
	building: string | null

	@Prop({ type: String, default: null })
	apartment: string | null
}

export const DeliveryAddressSchema = SchemaFactory.createForClass(DeliveryAddress)

@Schema({ _id: false })
export class AppliedDiscount {
	@Prop({ type: Types.ObjectId, ref: 'DiscountCoupon', required: true })
	coupon_id: Types.ObjectId

	@Prop({ required: true })
	code: string

	@Prop({ required: true, min: 0, max: 100 })
	discount_percent: number

	@Prop({ required: true, min: 0 })
	discount_amount: number
}

export const AppliedDiscountSchema = SchemaFactory.createForClass(AppliedDiscount)

/**
 * A fixed-amount discount the admin grants after checkout (the buyer asked for 50 ₴ off).
 * It stacks on top of the coupon and is only allowed while the order is unpaid — after that
 * the money has moved and taking it back is a refund, not a discount.
 */
@Schema({ _id: false })
export class ManualDiscount {
	@Prop({ required: true, min: 0 })
	amount: number

	@Prop({ required: true })
	reason: string

	@Prop({ type: Date, required: true })
	applied_at: Date
}

export const ManualDiscountSchema = SchemaFactory.createForClass(ManualDiscount)

/** The last Nova Post tracking result the hourly job saw for `nova_post_ttn`. */
@Schema({ _id: false })
export class NovaPostTrackingStatus {
	/** `StatusCode` as Nova Post returns it — a string («9», «102»…). */
	@Prop({ type: String, required: true })
	code: string

	@Prop({ type: String, required: true })
	text: string

	@Prop({ type: Date, required: true })
	checked_at: Date
}

export const NovaPostTrackingStatusSchema = SchemaFactory.createForClass(NovaPostTrackingStatus)

@Schema({ collection: 'orders', timestamps: true })
export class Order {
	@Prop({ required: true, unique: true })
	order_number: string

	@Prop({ type: Types.ObjectId, ref: 'User', default: null })
	user_id: Types.ObjectId | null

	@Prop({ type: CustomerSnapshotSchema, required: true })
	customer: CustomerSnapshot

	@Prop({ type: [OrderItemSchema], required: true })
	items: OrderItem[]

	@Prop({ required: true })
	total_price: number

	@Prop({ required: true })
	subtotal_price: number

	@Prop({ type: AppliedDiscountSchema, default: null })
	applied_discount: AppliedDiscount | null

	@Prop({ type: ManualDiscountSchema, default: null })
	manual_discount: ManualDiscount | null

	@Prop({ type: String, enum: PaymentMethod, required: true })
	payment_method: PaymentMethod

	@Prop({ type: String, enum: PaymentStatus, default: PaymentStatus.PENDING })
	payment_status: PaymentStatus

	@Prop({ type: String, default: null })
	payment_transaction_id: string | null

	/**
	 * When the LiqPay checkout payload was last built for this order. A second card session
	 * within the cooldown is refused while the payment is still PENDING — the first one may yet
	 * complete, and two live sessions is how a buyer gets charged twice (TD-0009 §5.4.3).
	 */
	@Prop({ type: Date, default: null })
	liqpay_checkout_started_at: Date | null

	@Prop({ type: String, enum: DeliveryMethod, required: true })
	delivery_method: DeliveryMethod

	@Prop({ type: DeliveryAddressSchema, default: null })
	delivery_address: DeliveryAddress | null

	@Prop({ type: String, default: null })
	nova_post_ttn: string | null

	/** Written by the delivery tracker (`order/tracking`); reset whenever the TTN changes. */
	@Prop({ type: NovaPostTrackingStatusSchema, default: null })
	nova_post_status: NovaPostTrackingStatus | null

	/**
	 * The issue code (refusal, return, TTN not found) the admin was last emailed about, so one
	 * refusal is one email and not one an hour. Reset with the TTN.
	 */
	@Prop({ type: String, default: null })
	nova_post_alerted_code: string | null

	@Prop({ type: String, enum: OrderStatus, default: OrderStatus.NEW })
	order_status: OrderStatus

	@Prop({ type: String, default: null })
	comment: string | null
}

export const OrderSchema = SchemaFactory.createForClass(Order)
OrderSchema.index({ user_id: 1 })
OrderSchema.index({ order_status: 1 })
OrderSchema.index({ payment_status: 1 })
export type OrderDocument = HydratedDocument<Order>
