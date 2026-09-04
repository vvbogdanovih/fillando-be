import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ColorRepository } from 'src/database/mongoose/repositories/color.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { generateSlug } from 'src/common/utils'
import { CreateColorDto } from './dto/create-color.dto'
import { UpdateColorDto } from './dto/update-color.dto'

@Injectable()
export class ColorService {
	private readonly logger = new Logger(ColorService.name)

	constructor(
		private readonly colorRepository: ColorRepository,
		private readonly productVariantRepository: ProductVariantRepository
	) {}

	findAll() {
		return this.colorRepository.findAllOrdered()
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
	 * Updating `family` also rewrites the denormalized `color_family` on every variant of this
	 * colour (TD-0002 §5.2.2).
	 *
	 * The design asked for one transaction, which this deployment cannot give: the database is a
	 * standalone MongoDB 7, and transactions need a replica set. So the two writes are ordered
	 * instead — the dictionary, which is the source of truth, then the variants derived from it.
	 * If the backfill fails the request fails too, and the variants are recomputable: re-issuing
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
		return updated
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
				`Colour is still used by ${inUse} variant(s) — reassign them before deleting`
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
