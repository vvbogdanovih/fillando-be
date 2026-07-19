import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Types } from 'mongoose'
import { ProductStatus } from 'src/common/types/enums'

@Schema({ collection: 'product_variants', timestamps: true })
export class ProductVariant {
	@Prop({ type: Types.ObjectId, ref: 'Product', required: true })
	product_id: Types.ObjectId

	@Prop({ type: Types.ObjectId, ref: 'Category', required: true })
	category_id: Types.ObjectId

	@Prop({ required: true })
	name: string

	@Prop({ required: true })
	slug: string

	@Prop({ required: true })
	sku: string

	@Prop({ required: true })
	price: number

	@Prop({ default: 0 })
	stock: number

	@Prop([String])
	images: string[]

	@Prop({ type: String, default: null })
	v_value: string | null

	@Prop()
	vendor_product_sku?: string

	@Prop()
	prom_id?: string

	@Prop({ type: Date, default: null })
	price_updated_at: Date | null

	@Prop({ type: Date, default: null })
	stock_updated_at: Date | null

	@Prop({ type: String, enum: ProductStatus, default: ProductStatus.ACTIVE })
	status: ProductStatus
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant)
ProductVariantSchema.index({ product_id: 1 })
ProductVariantSchema.index({ category_id: 1, status: 1 })
ProductVariantSchema.index({ slug: 1 }, { unique: true })
ProductVariantSchema.index({ sku: 1 }, { unique: true })
export type ProductVariantDocument = HydratedDocument<ProductVariant>
