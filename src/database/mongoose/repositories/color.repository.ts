import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import { Color } from '../schemas/color.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class ColorRepository extends BaseRepository<Color> {
	constructor(@InjectModel(Color.name) model: Model<Color>) {
		super(model)
	}

	/** Dictionary order: explicit `order` first, then alphabetical so ties are stable. */
	findAllOrdered(): Promise<Color[]> {
		return this.model.find({}).sort({ order: 1, name_en: 1 }).lean().exec()
	}

	findBySlug(slug: string): Promise<HydratedDocument<Color> | null> {
		return this.findOne({ slug })
	}
}
