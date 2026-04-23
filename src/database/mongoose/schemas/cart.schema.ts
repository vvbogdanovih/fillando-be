import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'

@Schema({ _id: false })
export class CartItem {
	@Prop({ type: Types.ObjectId, ref: 'ProductVariant', required: true })
	variant_id: Types.ObjectId

	@Prop({ required: true, min: 1 })
	quantity: number

	@Prop({ default: () => new Date() })
	added_at: Date
}

export const CartItemSchema = SchemaFactory.createForClass(CartItem)

@Schema({ collection: 'carts', timestamps: true })
export class Cart {
	@Prop({ type: Types.ObjectId, ref: 'User', required: true })
	user_id: Types.ObjectId

	@Prop({ type: [CartItemSchema], default: [] })
	items: CartItem[]
}

export const CartSchema = SchemaFactory.createForClass(Cart)
CartSchema.index({ user_id: 1 }, { unique: true })
export type CartDocument = HydratedDocument<Cart>
