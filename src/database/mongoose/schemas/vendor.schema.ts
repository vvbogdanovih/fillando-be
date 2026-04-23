import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ collection: 'vendors', timestamps: true })
export class Vendor {
	@Prop({ required: true, unique: true })
	name: string

	@Prop({ required: true, unique: true })
	slug: string
}

export const VendorSchema = SchemaFactory.createForClass(Vendor)
export type VendorDocument = HydratedDocument<Vendor>
