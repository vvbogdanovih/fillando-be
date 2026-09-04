import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose'
import { LandingStatus } from 'src/common/types/enums'

@Schema({ _id: false })
export class LandingFaqItem {
	@Prop({ required: true })
	q: string

	@Prop({ required: true })
	a: string
}

export const LandingFaqItemSchema = SchemaFactory.createForClass(LandingFaqItem)

/**
 * A SEO landing page over a category: a fixed set of catalogue filters plus its own copy
 * (TD-0002 §5.2.3). Categories stay flat — a landing is a separate entity with pinned
 * filters, not a nested category.
 */
@Schema({ collection: 'landings', timestamps: true })
export class Landing {
	@Prop({ type: Types.ObjectId, ref: 'Category', required: true })
	category_id: Types.ObjectId

	/** Unique within the category — the public URL is `/{categorySlug}/{slug}`. */
	@Prop({ required: true, trim: true })
	slug: string

	@Prop({ required: true })
	h1: string

	@Prop({ required: true })
	title: string

	@Prop({ required: true })
	meta_description: string

	/** Sanitized on write; rendered above the product grid. */
	@Prop({ default: '' })
	intro_html: string

	/** Sanitized on write; the main SEO copy, rendered below the grid. */
	@Prop({ default: '' })
	bottom_html: string

	@Prop({ type: [LandingFaqItemSchema], default: [] })
	faq: LandingFaqItem[]

	/**
	 * Pinned catalogue filters, `attrKey -> values[]` (e.g. `{ polymer: ['PLA'], finish: ['Silk'] }`).
	 * Keys are the ones `generateAttrKey` produces, so they must stay in step with
	 * `ATTR_KEY_OVERRIDES`. Values may not contain a comma — `getCatalog` splits on it.
	 */
	@Prop({ type: MongooseSchema.Types.Mixed, default: {} })
	filters: Record<string, string[]>

	@Prop({ type: Number, default: null })
	price_min: number | null

	@Prop({ type: Number, default: null })
	price_max: number | null

	@Prop({ type: String, default: null })
	image: string | null

	@Prop({ type: Number, default: 0 })
	order: number

	@Prop({ type: String, enum: LandingStatus, default: LandingStatus.DRAFT })
	status: LandingStatus
}

export const LandingSchema = SchemaFactory.createForClass(Landing)
LandingSchema.index({ category_id: 1, slug: 1 }, { unique: true })
LandingSchema.index({ category_id: 1, status: 1, order: 1 })
export type LandingDocument = HydratedDocument<Landing>
