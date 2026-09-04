import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'
import { ColorFamily } from 'src/common/types/enums'

/**
 * Colour dictionary (TD-0002 §5.2.2). One row per manufacturer colour; variants point at it
 * through `ProductVariant.color_id` and denormalize `family` into `color_family`.
 */
@Schema({ collection: 'colors', timestamps: true })
export class Color {
	/** Canonical manufacturer name, e.g. 'Black', 'Bambu Green'. Unique — the migration matches on it. */
	@Prop({ required: true, unique: true, trim: true })
	name_en: string

	/** Ukrainian name shown to shoppers, e.g. 'Чорний'. The storefront renders "name_uk (name_en)". */
	@Prop({ required: true, trim: true })
	name_uk: string

	/** Derived from `name_en`; part of the variant slug. */
	@Prop({ required: true, unique: true, trim: true })
	slug: string

	@Prop({ required: true, type: String, enum: ColorFamily })
	family: ColorFamily

	/**
	 * 1..6 ordered `#RRGGBB` stops. One stop is a solid swatch, several a gradient, and for
	 * `family: multicolor` a conic one. `hex_stops[0]` is the primary colour wherever a single
	 * value is needed (the Merchant feed's `g:color`, a fallback icon). The cap keeps a 22–30px
	 * swatch readable — more stops are indistinguishable at that size.
	 */
	@Prop({ type: [String], required: true })
	hex_stops: string[]

	@Prop({ type: Number, default: 0 })
	order: number
}

export const ColorSchema = SchemaFactory.createForClass(Color)
ColorSchema.index({ order: 1, name_en: 1 })
export type ColorDocument = HydratedDocument<Color>
