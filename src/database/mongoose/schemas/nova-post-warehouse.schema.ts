import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ collection: 'nova_post_warehouses' })
export class NovaPostWarehouse {
	@Prop({ required: true, unique: true })
	ref: string

	@Prop({ required: true })
	description: string

	@Prop({ required: true })
	shortAddress: string

	@Prop({ required: true })
	number: number

	@Prop({ required: true })
	cityRef: string

	@Prop({ required: true })
	cityName: string

	@Prop({ required: true })
	maxWeightAllowed: number

	@Prop({ required: true })
	typeOfWarehouse: string

	@Prop({ required: true })
	postalCode: string
}

export const NovaPostWarehouseSchema = SchemaFactory.createForClass(NovaPostWarehouse)
export type NovaPostWarehouseDocument = HydratedDocument<NovaPostWarehouse>
