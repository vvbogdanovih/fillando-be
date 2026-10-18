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

	/**
	 * Set when the token is consumed by `POST /auth/refresh`. The record outlives its use for
	 * `REFRESH_REUSE_GRACE_MS` so a second tab racing the same cookie is served rather than
	 * logged out; records without this field (written before the window existed) are unused.
	 */
	@Prop()
	usedAt?: Date
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken)
export type RefreshTokenDocument = HydratedDocument<RefreshToken>
