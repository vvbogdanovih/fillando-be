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

	/** Last pre-discount price seen on Prom. Kept for auditing how `price` was derived. */
	@Prop({ type: Number, default: null })
	prom_base_price: number | null

	/**
	 * Last discount Prom reported for this product, as a fraction of the pre-discount price
	 * (0..1). Stored as a ratio rather than the absolute ₴ amount because the vendor's base
	 * price moves — a stale ₴ figure would misprice, a stale ratio would not.
	 */
	@Prop({ type: Number, default: null })
	prom_discount_ratio: number | null

	/** When {@link ProductVariant.prom_discount_ratio} was last refreshed from Prom. */
	@Prop({ type: Date, default: null })
	prom_discount_seen_at: Date | null

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
