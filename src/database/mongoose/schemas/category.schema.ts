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

/**
 * Google product taxonomy node for the Merchant feed (TD-0006 §5.2). `id` is the canonical
 * value — it survives Google renaming a path — and `path` is what the admin reads. Lives on the
 * category, per the isolation contract (TD-0005): a new category sets its own, nothing global.
 */
@Schema({ _id: false })
export class GoogleProductCategory {
	@Prop({ required: true })
	id: number

	@Prop({ required: true })
	path: string
}

export const GoogleProductCategorySchema = SchemaFactory.createForClass(GoogleProductCategory)

@Schema({ collection: 'categories', timestamps: true })
export class Category {
	@Prop({ required: true, unique: true })
	name: string

	@Prop({ required: true, unique: true })
	slug: string

	@Prop({ type: [RequiredAttributeSchema], default: [] })
	required_attributes: RequiredAttribute[]

	@Prop({ type: String, default: null })
	image: string | null

	@Prop({ type: Number, default: 0 })
	order: number

	/** Null is allowed: the feed then omits `g:google_product_category` and reports a warning. */
	@Prop({ type: GoogleProductCategorySchema, default: null })
	google_product_category: GoogleProductCategory | null
}

export const CategorySchema = SchemaFactory.createForClass(Category)
export type CategoryDocument = HydratedDocument<Category>
