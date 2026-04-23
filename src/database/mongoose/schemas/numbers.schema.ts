import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ collection: 'numbers', timestamps: false })
export class Numbers {
	@Prop({ default: 0 })
	sku: number

	@Prop({ default: 0 })
	order: number

	@Prop({ default: 0 })
	discount_coupon: number
}

export const NumbersSchema = SchemaFactory.createForClass(Numbers)
export type NumbersDocument = HydratedDocument<Numbers>
