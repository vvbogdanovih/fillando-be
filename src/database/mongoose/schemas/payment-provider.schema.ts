import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'
import { PaymentProvider } from 'src/common/types/enums'

@Schema({ collection: 'payment_providers', timestamps: true })
export class PaymentProviderCredentials {
	@Prop({ required: true, enum: PaymentProvider, index: true })
	provider: PaymentProvider

	@Prop({ required: true })
	label: string

	@Prop({ required: true })
	public_key: string

	// AES-256-GCM encrypted merchant private key. Never returned over HTTP.
	@Prop({ required: true })
	private_key_enc: string

	@Prop({ default: false })
	is_active: boolean

	@Prop({ default: false })
	sandbox: boolean
}

export const PaymentProviderSchema = SchemaFactory.createForClass(PaymentProviderCredentials)
export type PaymentProviderDocument = HydratedDocument<PaymentProviderCredentials>
