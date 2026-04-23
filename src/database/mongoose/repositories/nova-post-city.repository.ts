import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import { NovaPostCity } from '../schemas/nova-post-city.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class NovaPostCityRepository extends BaseRepository<NovaPostCity> {
	constructor(@InjectModel(NovaPostCity.name) model: Model<NovaPostCity>) {
		super(model)
	}

	findByRef(ref: string): Promise<HydratedDocument<NovaPostCity> | null> {
		return this.findOne({ ref })
	}

	search(q: string): Promise<NovaPostCity[]> {
		const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		return this.model.aggregate([
			{ $match: { name: { $regex: escaped, $options: 'i' } } },
			{
				$addFields: {
					_score: {
						$switch: {
							branches: [
								{
									case: { $eq: [{ $toLower: '$name' }, q.toLowerCase()] },
									then: 0
								},
								{
									case: {
										$regexMatch: {
											input: '$name',
											regex: `^${escaped}`,
											options: 'i'
										}
									},
									then: 1
								}
							],
							default: 2
						}
					}
				}
			},
			{ $sort: { _score: 1, name: 1 } },
			{ $project: { _score: 0 } }
		])
	}

	clearAll(): Promise<unknown> {
		return this.model.deleteMany({})
	}

	async bulkUpsert(docs: Partial<NovaPostCity>[]): Promise<number> {
		if (!docs.length) return 0
		const ops = docs.map(doc => ({
			updateOne: {
				filter: { ref: doc.ref },
				update: { $set: doc },
				upsert: true
			}
		}))
		const result = await this.model.bulkWrite(ops)
		return result.upsertedCount + result.modifiedCount
	}
}
