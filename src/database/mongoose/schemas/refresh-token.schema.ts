import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'

@Schema({ collection: 'refresh_tokens', timestamps: true })
export class RefreshToken {
	@Prop({ required: true, unique: true })
	token: string

	@Prop({ type: Types.ObjectId, ref: 'User', required: true })
	userId: Types.ObjectId

	@Prop()
	userAgent?: string

	@Prop()
	ipAddress?: string

	@Prop({ required: true })
	expiresAt: Date
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken)
export type RefreshTokenDocument = HydratedDocument<RefreshToken>
