import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ collection: 'nova_post_cities' })
export class NovaPostCity {
	@Prop({ required: true, unique: true })
	ref: string

	@Prop({ required: true })
	name: string

	@Prop({ required: true })
	settlementType: string

	@Prop({ required: true })
	area: string
}

export const NovaPostCitySchema = SchemaFactory.createForClass(NovaPostCity)
export type NovaPostCityDocument = HydratedDocument<NovaPostCity>
