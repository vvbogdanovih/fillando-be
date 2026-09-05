import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose'

@Schema({ _id: false })
export class Attribute {
	@Prop({ required: true })
	k: string

	@Prop({ required: true })
	l: string

	@Prop({ required: true, type: MongooseSchema.Types.Mixed })
	v: string | number | boolean
}

export const AttributeSchema = SchemaFactory.createForClass(Attribute)

@Schema({ _id: false })
export class ProductDescription {
	@Prop({ type: MongooseSchema.Types.Mixed, required: true })
	json: Record<string, unknown>

	@Prop({ required: true })
	html: string
}

export const ProductDescriptionSchema = SchemaFactory.createForClass(ProductDescription)

@Schema({ _id: false })
export class VariantType {
	@Prop({ required: true })
	key: string

	@Prop({ required: true })
	label: string
}

export const VariantTypeSchema = SchemaFactory.createForClass(VariantType)

@Schema({ collection: 'products', timestamps: true })
export class Product {
	@Prop({ required: true })
	name: string

	@Prop({ type: Types.ObjectId, ref: 'Category', required: true })
	category_id: Types.ObjectId

	@Prop({ type: Types.ObjectId, ref: 'Vendor', required: true })
	vendor_id: Types.ObjectId

	@Prop({ type: ProductDescriptionSchema })
	description?: ProductDescription

	@Prop({ type: VariantTypeSchema })
	variant_type?: VariantType

	@Prop({ type: [AttributeSchema], default: [] })
	attributes: Attribute[]

	/**
	 * Set on a refill product only: the product whose filament comes on a spool.
	 *
	 * `split-refill-products.js` creates the refill as a product of its own, and the pairing has
	 * to survive that split — the shopper on a refill page needs to see what the spooled version
	 * costs and be able to reach it. Before the split the two are variants of one product and
	 * the storefront finds the counterpart among the siblings; afterwards there are no siblings
	 * to look in, and this is the only thing that still connects them.
	 */
	@Prop({ type: Types.ObjectId, ref: 'Product', default: null })
	spooled_product_id?: Types.ObjectId | null
}

export const ProductSchema = SchemaFactory.createForClass(Product)
ProductSchema.index({ 'attributes.k': 1, 'attributes.v': 1 })
ProductSchema.index(
	{ name: 'text', 'description.html': 'text', 'attributes.v': 'text', 'attributes.l': 'text' },
	{
		weights: { name: 10, 'attributes.v': 5, 'attributes.l': 3, 'description.html': 1 },
		default_language: 'none',
		name: 'product_text_search'
	}
)
export type ProductDocument = HydratedDocument<Product>
