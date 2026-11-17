import { mongo } from 'mongoose'
import { generateSlug } from 'src/common/utils/attribute.utils'
import { TypedProductError } from './typed-product'
export class ProductIdentityAllocator {
	constructor(private readonly db: mongo.Db) {}
	async reserveSkus(count: number) {
		const counters = await this.db.collection('numbers').find({}).limit(2).toArray()
		const counter = counters[0]
		if (
			counters.length !== 1 ||
			!Number.isSafeInteger(counter.sku) ||
			counter.sku < 0 ||
			!Number.isSafeInteger(counter.sku + count)
		)
			throw new TypedProductError('SKU_COUNTER_UNAVAILABLE')
		// Reservation is intentionally monotonic and outside rollback. Lost reservations leave gaps.
		const reserved = await this.db
			.collection('numbers', { writeConcern: { w: 1, j: true } })
			.findOneAndUpdate(
				{ _id: counter._id, sku: counter.sku },
				{ $inc: { sku: count } },
				{ returnDocument: 'after' }
			)
		if (!reserved || !Number.isSafeInteger(reserved.sku))
			throw new TypedProductError('SKU_COUNTER_CONFLICT')
		const last = reserved.sku as number
		return Array.from(
			{ length: count },
			(_, index) => `FL-${String(last - count + index + 1).padStart(6, '0')}`
		)
	}
	async slugTaken(slug: string) {
		return (
			!!(await this.db
				.collection('product_variants')
				.findOne({ slug }, { projection: { _id: 1 } })) ||
			!!(await this.db
				.collection('catalog_routes')
				.findOne({ path: `/products/${slug}` }, { projection: { _id: 1 } }))
		)
	}
	async requireIndexes() {
		const indexes = await this.db.collection('product_variants').indexes()
		if (
			!['sku', 'slug'].every(field =>
				indexes.some(
					index =>
						index.unique &&
						Object.keys(index.key).length === 1 &&
						index.key[field] === 1 &&
						!index.partialFilterExpression &&
						!index.sparse
				)
			)
		)
			throw new TypedProductError('PRODUCT_IDENTITY_INDEX_MISSING')
	}
	async allocate(name: string, sku: string, reserved: ReadonlySet<string> = new Set()) {
		const base = generateSlug(name).slice(0, 160).replace(/-$/, '')
		let slug = base
		if (!slug || reserved.has(slug) || (await this.slugTaken(slug)))
			slug = `${base || 'product'}-${sku.toLowerCase()}`
		if (reserved.has(slug) || (await this.slugTaken(slug)))
			throw new TypedProductError('PRODUCT_IDENTITY_CONFLICT')
		return slug
	}
}
