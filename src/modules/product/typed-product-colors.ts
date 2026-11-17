import { mongo } from 'mongoose'
import { formatColorLabel } from './product.service'

export interface AxisColor {
	id: mongo.ObjectId
	family: string
	name_en: string
	/** «Чорний (Black)» — the label the legacy `variantName` puts after the product name. */
	label: string
}

/**
 * Dictionary colours for the values of a colour axis (TD-0013 B08): the stored value is the
 * `colors._id` hex string. Unknown or malformed ids are simply absent from the map, so the
 * caller refuses them instead of naming a SKU after an id.
 */
export async function loadAxisColors(db: mongo.Db, values: unknown[]) {
	const ids = [
		...new Set(
			values.filter(
				(value): value is string =>
					typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
			)
		)
	]
	const rows = ids.length
		? await db
				.collection('colors')
				.find(
					{ _id: { $in: ids.map(id => new mongo.ObjectId(id)) } },
					{ readPreference: 'primary' }
				)
				.toArray()
		: []
	return new Map(
		rows.map(row => [
			String(row._id),
			{
				id: row._id,
				family: String(row.family),
				name_en: String(row.name_en),
				label:
					formatColorLabel(row.name_uk as string, row.name_en as string) ??
					String(row.name_en)
			} satisfies AxisColor
		])
	)
}
