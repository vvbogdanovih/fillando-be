import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

@Schema({ _id: false })
export class RequiredAttribute {
	@Prop({ required: true })
	key: string

	@Prop({ required: true })
	label: string

	@Prop({ required: true, enum: ['multi-select', 'range'] })
	filter_type: 'multi-select' | 'range'

	@Prop({ type: String, default: null })
	unit: string | null
}

export const RequiredAttributeSchema = SchemaFactory.createForClass(RequiredAttribute)

@Schema({ _id: true })
export class Subcategory {
	@Prop({ required: true })
	name: string

	@Prop({ required: true })
	slug: string

	@Prop({ type: [RequiredAttributeSchema], default: [] })
	required_attributes: RequiredAttribute[]
}

export const SubcategorySchema = SchemaFactory.createForClass(Subcategory)

@Schema({ collection: 'categories', timestamps: true })
export class Category {
	@Prop({ required: true, unique: true })
	name: string

	@Prop({ required: true, unique: true })
	slug: string

	@Prop({ type: [SubcategorySchema], default: [] })
	subcategories: Subcategory[]

	@Prop({ type: String, default: null })
	image: string | null

	@Prop({ type: Number, default: 0 })
	order: number
}

export const CategorySchema = SchemaFactory.createForClass(Category)
CategorySchema.index({ 'subcategories._id': 1 })
export type CategoryDocument = HydratedDocument<Category>
