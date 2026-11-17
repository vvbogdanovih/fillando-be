import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import type * as mongoose from 'mongoose'
import { NovaPostWarehouse } from '../schemas/nova-post-warehouse.schema'
import { BaseRepository } from './base.repository'

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Collapses query whitespace; matches tokens with flexible spaces in stored text. */
function flexibleWhitespacePattern(normalizedQ: string): string {
	const parts = normalizedQ.split(/\s+/).filter(Boolean).map(escapeRegex)
	return parts.join('\\s+')
}

@Injectable()
export class NovaPostWarehouseRepository extends BaseRepository<NovaPostWarehouse> {
	constructor(@InjectModel(NovaPostWarehouse.name) model: Model<NovaPostWarehouse>) {
		super(model)
	}

	findByRef(ref: string): Promise<HydratedDocument<NovaPostWarehouse> | null> {
		return this.findOne({ ref })
	}

	/**
	 * Ordered by branch number: a list that mixes post and cargo branches reads «№1, №2, №3…»
	 * like the carrier's own, instead of in the order the sync happened to store them.
	 */
	findByCityRef(
		cityRef: string,
		typesOfWarehouse?: string[],
		q?: string
	): Promise<NovaPostWarehouse[]> {
		const filter: mongoose.QueryFilter<NovaPostWarehouse> = { cityRef }
		if (typesOfWarehouse?.length) filter.typeOfWarehouse = { $in: typesOfWarehouse }
		if (q !== undefined && q !== null) {
			const normalizedQ = q.trim().replace(/\s+/g, ' ')
			if (normalizedQ) {
				const textPattern = flexibleWhitespacePattern(normalizedQ)
				const numSubstringPattern = escapeRegex(normalizedQ)
				filter.$or = [
					{
						$expr: {
							$regexMatch: {
								input: { $toString: '$number' },
								regex: numSubstringPattern
							}
						}
					},
					{ description: { $regex: textPattern, $options: 'i' } },
					{ shortAddress: { $regex: textPattern, $options: 'i' } }
				]
			}
		}
		return this.model.find(filter).sort({ number: 1 }).lean().exec()
	}

	clearAll(): Promise<unknown> {
		return this.model.deleteMany({})
	}

	async bulkUpsert(docs: Partial<NovaPostWarehouse>[]): Promise<number> {
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
