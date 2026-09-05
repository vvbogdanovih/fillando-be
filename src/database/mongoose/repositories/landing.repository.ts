import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model, Types } from 'mongoose'
import { LandingStatus } from 'src/common/types/enums'
import { Landing } from '../schemas/landing.schema'
import { BaseRepository } from './base.repository'

/** One published landing as the sitemap needs it: both slugs plus the last edit. */
export interface LandingSlugRow {
	category_slug: string
	slug: string
	updatedAt: Date
}

@Injectable()
export class LandingRepository extends BaseRepository<Landing> {
	constructor(@InjectModel(Landing.name) model: Model<Landing>) {
		super(model)
	}

	/**
	 * PUBLIC SURFACE — active landings only. A draft is unpublished copy; returning it here
	 * would repeat the defect Plan-0003 closed for draft products.
	 */
	findActive(categoryId?: string): Promise<(Landing & { _id: Types.ObjectId })[]> {
		const filter: Record<string, unknown> = { status: LandingStatus.ACTIVE }
		if (categoryId) filter.category_id = new Types.ObjectId(categoryId)
		return this.model
			.find(filter)
			.sort({ order: 1, h1: 1 })
			.lean<(Landing & { _id: Types.ObjectId })[]>()
			.exec()
	}

	/** Admin listing — drafts included, since that is what the editor works on. */
	findAllForAdmin(categoryId?: string): Promise<(Landing & { _id: Types.ObjectId })[]> {
		const filter: Record<string, unknown> = {}
		if (categoryId) filter.category_id = new Types.ObjectId(categoryId)
		return this.model
			.find(filter)
			.sort({ order: 1, h1: 1 })
			.lean<(Landing & { _id: Types.ObjectId })[]>()
			.exec()
	}

	/** PUBLIC SURFACE — active only, so an unpublished address is a 404 for visitors. */
	findActiveByCategoryAndSlug(
		categoryId: Types.ObjectId,
		slug: string
	): Promise<HydratedDocument<Landing> | null> {
		return this.findOne({ category_id: categoryId, slug, status: LandingStatus.ACTIVE })
	}

	findByCategoryAndSlug(
		categoryId: Types.ObjectId,
		slug: string
	): Promise<HydratedDocument<Landing> | null> {
		return this.findOne({ category_id: categoryId, slug })
	}

	/** PUBLIC SURFACE — active only; the sitemap must not advertise drafts. */
	async findActiveSlugs(): Promise<LandingSlugRow[]> {
		return this.model
			.aggregate<LandingSlugRow>([
				{ $match: { status: LandingStatus.ACTIVE } },
				{
					$lookup: {
						from: 'categories',
						localField: 'category_id',
						foreignField: '_id',
						as: 'category'
					}
				},
				{ $unwind: '$category' },
				{
					$project: {
						_id: 0,
						category_slug: '$category.slug',
						slug: 1,
						updatedAt: 1
					}
				},
				{ $sort: { category_slug: 1, slug: 1 } }
			])
			.exec()
	}
}
