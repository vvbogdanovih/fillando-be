import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common'
import { Types } from 'mongoose'
import { ColorRepository } from 'src/database/mongoose/repositories/color.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import {
	StorefrontRevalidationService,
	storefrontRevalidation
} from 'src/common/services/storefront-revalidation.service'
import { generateSlug } from 'src/common/utils'
import { formatColorLabel, variantName } from 'src/modules/product/product.service'
import { CreateColorDto } from './dto/create-color.dto'
import { UpdateColorDto } from './dto/update-color.dto'

/** The dictionary fields a variant's display name is built from. */
interface ColorNames {
	name_uk?: string | null
	name_en?: string | null
}

@Injectable()
export class ColorService {
	private readonly logger = new Logger(ColorService.name)

	constructor(
		private readonly colorRepository: ColorRepository,
		private readonly productVariantRepository: ProductVariantRepository,
		/**
		 * Not a registered provider: `@Optional()` leaves it `undefined` and the default takes
		 * over, so this service shares one throttle window with the product and category writes
		 * (see the singleton's own note). A spec passes its own instance.
		 */
		@Optional()
		private readonly revalidation: StorefrontRevalidationService = storefrontRevalidation
	) {}

	findAll() {
		return this.colorRepository.findAllOrdered()
	}

	/**
	 * ADMIN — the dictionary plus how many variants use each entry (Plan-0005 D2).
	 *
	 * The count is what makes the unrecognized colour spellings tractable: it separates the
	 * entries carrying the catalogue from the ones seeded and never matched, which is otherwise
	 * invisible until a delete comes back 409.
	 *
	 * Deliberately not folded into the public {@link findAll}: that one is storefront data and
	 * would then pay for an aggregation on every call, and the count includes draft and
	 * archived variants, which is nobody's business outside the admin.
	 */
	async findAllForAdmin() {
		const [colors, counts] = await Promise.all([
			this.colorRepository.findAllOrdered(),
			this.productVariantRepository.countAllByColorId()
		])
		return colors.map(color => ({
			...color,
			variant_count: counts.get(String(color._id)) ?? 0
		}))
	}

	async findById(id: string) {
		this.assertObjectId(id)
		const color = await this.colorRepository.findById(id)
		if (!color) throw new NotFoundException('Color not found')
		return color
	}

	create(dto: CreateColorDto) {
		return this.colorRepository.create({
			...dto,
			slug: dto.slug?.trim() || generateSlug(dto.name_en),
			hex_stops: normalizeHexStops(dto.hex_stops)
		})
	}

	/**
	 * Updating a colour also rewrites what the variants of that colour denormalize from it: the
	 * `color_family` the catalogue filters by (TD-0002 §5.2.2) and the stored display `name`.
	 *
	 * The design asked for one transaction, which this deployment cannot give: the database is a
	 * standalone MongoDB 7, and transactions need a replica set. So the writes are ordered
	 * instead — the dictionary, which is the source of truth, then the variants derived from it.
	 * If a backfill fails the request fails too, and the variants are recomputable: re-issuing
	 * the same PATCH (or any later one) backfills again, because the check is on drift, not on a
	 * change of value.
	 */
	async update(id: string, dto: UpdateColorDto) {
		this.assertObjectId(id)
		const data = {
			...dto,
			...(dto.hex_stops && { hex_stops: normalizeHexStops(dto.hex_stops) })
		}
		const updated = await this.colorRepository.update({ _id: id }, data)
		if (!updated) throw new NotFoundException('Color not found')

		const backfilled = await this.productVariantRepository.updateColorFamilyByColorId(
			id,
			updated.family
		)
		if (backfilled > 0) {
			this.logger.log(
				`Colour ${updated.name_en} (${id}) is now "${updated.family}" — color_family rewritten on ${backfilled} variants`
			)
		}

		const renamed = await this.renameVariantsOfColor(id, updated)
		if (renamed > 0) {
			this.logger.log(
				`Colour ${updated.name_en} (${id}) — display name rewritten on ${renamed} variants`
			)
		}

		// The colour is on every catalogue card, in the cart row and in the price sheet, so a
		// rename that only the product page reflects is two names for one colour until the hour
		// lapses (I-h).
		this.revalidation.revalidate('products', 'colour update')
		return updated
	}

	/**
	 * Rewrites the stored `ProductVariant.name` of every variant of this colour.
	 *
	 * The name is `«<товар> — <Укр (EN)>»`, and the rule is `ProductService`'s own — imported,
	 * not restated, because two implementations of it are exactly how the catalogue card and the
	 * product page ended up in different languages. The product name comes back joined with the
	 * variant, so a colour used across thirty products is one aggregation, not thirty reads.
	 *
	 * **`v_value` and the slug are deliberately untouched.** `v_value` holds the canonical
	 * English spelling and the slug is generated from it, so addresses stay stable when an admin
	 * fixes a spelling — `v_value` disagreeing with `colors.name_en` is that design (TD-0002
	 * §5.2.2, "the slug keeps coming from `v_value`"), not drift to repair. Regenerating either
	 * here would move pages Google has already indexed, with no 301 behind them.
	 */
	private async renameVariantsOfColor(colorId: string, color: ColorNames): Promise<number> {
		const label = formatColorLabel(color.name_uk, color.name_en)
		const sources = await this.productVariantRepository.findNameSourcesByColorId(colorId)

		// Only the drifted ones. With no transaction available the backfill has to be
		// idempotent: a PATCH that moves `order` or a hex stop must write nothing at all, and a
		// backfill that failed halfway has to be repairable by re-issuing the same PATCH.
		const renames: Array<{ id: Types.ObjectId; name: string }> = []
		for (const source of sources) {
			const name = variantName(source.product_name, source.v_value, label)
			if (name !== source.name) renames.push({ id: source._id, name })
		}

		return this.productVariantRepository.renameVariants(renames)
	}

	/**
	 * Deleting a colour that variants still point at would strand `color_id` and leave
	 * `color_family` frozen at its last value, so the catalogue would keep filtering by a family
	 * no dictionary entry explains. Repoint the variants first.
	 */
	async delete(id: string) {
		this.assertObjectId(id)
		const inUse = await this.productVariantRepository.countByColorId(id)
		if (inUse > 0) {
			throw new ConflictException(
				`Колір використовують ${inUse} варіант(ів) — спершу перепризначте їм інший колір`
			)
		}
		const deleted = await this.colorRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Color not found')
		return { success: true }
	}

	private assertObjectId(id: string): void {
		if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Color not found')
	}
}

/** Hex is case-insensitive; store one casing so lookups and diffs are predictable. */
function normalizeHexStops(stops: string[]): string[] {
	return stops.map(stop => stop.toLowerCase())
}
