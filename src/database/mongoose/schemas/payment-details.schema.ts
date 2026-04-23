import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ collection: 'payment_details', timestamps: true })
export class PaymentDetails {
	@Prop({ required: true })
	last_name: string

	@Prop({ required: true })
	first_name: string

	@Prop()
	middle_name?: string

	@Prop({ required: true, unique: true })
	iban: string

	@Prop({ required: true })
	edrpou: string

	@Prop({ required: true })
	bank_name: string

	@Prop({ default: false })
	is_available: boolean
}

export const PaymentDetailsSchema = SchemaFactory.createForClass(PaymentDetails)
export type PaymentDetailsDocument = HydratedDocument<PaymentDetails>
