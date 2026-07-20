import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'
import { WholesaleInquiryStatus } from 'src/common/types/enums'

@Schema({ collection: 'wholesale_inquiries', timestamps: true })
export class WholesaleInquiry {
	@Prop({ required: true })
	name: string

	@Prop({ required: true })
	phone: string

	@Prop({ required: true })
	email: string

	@Prop({ required: true })
	quantity: string

	@Prop({ type: String, default: null })
	comment: string | null

	@Prop({
		type: String,
		enum: Object.values(WholesaleInquiryStatus),
		default: WholesaleInquiryStatus.NEW
	})
	status: WholesaleInquiryStatus
}

export const WholesaleInquirySchema = SchemaFactory.createForClass(WholesaleInquiry)
export type WholesaleInquiryDocument = HydratedDocument<WholesaleInquiry>
