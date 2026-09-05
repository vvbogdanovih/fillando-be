import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { Color } from '../schemas/color.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class ColorRepository extends BaseRepository<Color> {
	constructor(@InjectModel(Color.name) model: Model<Color>) {
		super(model)
	}

	/** Dictionary order: explicit `order` first, then alphabetical so ties are stable. */
	findAllOrdered(): Promise<(Color & { _id: Types.ObjectId })[]> {
		return this.model
			.find({})
			.sort({ order: 1, name_en: 1 })
			.lean<(Color & { _id: Types.ObjectId })[]>()
			.exec()
	}

	findBySlug(slug: string): Promise<HydratedDocument<Color> | null> {
		return this.findOne({ slug })
	}

	/**
	 * Dictionary rows for a set of ids in one query. Renaming a product has to relabel every
	 * one of its variants, and each needs its own Ukrainian colour name — a lookup per variant
	 * would make an ordinary admin save issue a dozen round trips.
	 */
	findByIds(ids: Types.ObjectId[]): Promise<(Color & { _id: Types.ObjectId })[]> {
		return this.model
			.find({ _id: { $in: ids } })
			.lean<(Color & { _id: Types.ObjectId })[]>()
			.exec()
	}
}
