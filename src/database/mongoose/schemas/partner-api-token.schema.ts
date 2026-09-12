import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Types } from 'mongoose'

@Schema({ collection: 'partner_api_tokens', timestamps: true })
export class PartnerApiToken {
	@Prop({ required: true, maxlength: 100 }) name: string
	@Prop({ required: true, unique: true, select: false }) token_hash: string
	@Prop({ required: true }) prefix: string
	@Prop({ type: Types.ObjectId, required: true }) created_by: Types.ObjectId
	@Prop({ type: Date, default: null }) revoked_at: Date | null
	@Prop({ type: Date, default: null }) last_used_at: Date | null
	createdAt: Date
}
export const PartnerApiTokenSchema = SchemaFactory.createForClass(PartnerApiToken)
