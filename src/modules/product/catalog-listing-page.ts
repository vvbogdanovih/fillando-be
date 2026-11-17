import type { Connection, mongo } from 'mongoose'

/**
 * Pure parts of the split whole-catalogue / group listing (Plan-0010 D06, `PublicCatalogService`):
 * which slice of the in-stock and the sold-out run a page covers, the price order of a page merged
 * from the index walk and the promoted SKUs, and the write mark that invalidates cached totals.
 */

/** A run of the listing: sold-out SKUs always follow every in-stock one, under every order. */
export type PageSegment = { out: boolean; skip: number; take: number }

/**
 * The segments of the window `[offset, offset + limit)` over `total` SKUs of which the first
 * `inStock` are in stock — the same positions `{_out_of_stock: 1, …}` gives the single sort.
 */
export function pageSegments(
	offset: number,
	limit: number,
	total: number,
	inStock: number
): PageSegment[] {
	const end = Math.min(offset + limit, total)
	const segments: PageSegment[] = []
	if (offset < Math.min(end, inStock))
		segments.push({ out: false, skip: offset, take: Math.min(end, inStock) - offset })
	if (end > Math.max(offset, inStock))
		segments.push({
			out: true,
			skip: Math.max(offset, inStock) - inStock,
			take: end - Math.max(offset, inStock)
		})
	return segments
}

/** A SKU position under a price order: its effective price and its id (the tie-breaker). */
export type PricedId = { _id: mongo.ObjectId; key: number | null }

/**
 * `rows` in the catalogue's price order — effective price `direction`, then `_id` ascending, a
 * missing price lowest (BSON order: null sorts before numbers) — sliced to `[skip, skip + take)`.
 */
export function slicePriced(
	rows: PricedId[],
	direction: 1 | -1,
	skip: number,
	take: number
): PricedId[] {
	const rank = (row: PricedId) => (row.key === null ? -Infinity : row.key)
	return [...rows]
		.sort(
			(a, b) =>
				direction * (rank(a) - rank(b)) ||
				(a._id.toHexString() < b._id.toHexString()
					? -1
					: a._id.toHexString() > b._id.toHexString()
						? 1
						: 0)
		)
		.slice(skip, skip + take)
}

/**
 * The first `limit` rows of an index walk ordered by price alone, made exact for the
 * `(price, _id ↑)` order: ties of the last price may be cut anywhere by the walk (it orders them
 * by record, and backwards for a descending walk), so all of them are taken instead — every row
 * priced before the edge is already in `head`.
 */
export function withTies(head: PricedId[], limit: number, ties: () => Promise<PricedId[]>) {
	if (head.length < limit) return Promise.resolve(head)
	const edge = head[limit - 1].key
	return ties().then(all => [...head.filter(row => row.key !== edge), ...all])
}

/**
 * A mark of every write to `product_variants` since the server started: the collection's own
 * operation counters (`$collStats` latency stats — insert, update, delete, no-op updates and
 * transactions alike, from any client: API, CLI, a raw script) and its document count. Read before
 * a scan, it changes after any write acknowledged in between, so a total cached under the old mark
 * is never served after a write the client has seen acknowledged. ~0.7 ms. `null` when the server
 * does not report it (callers then compute on every request).
 */
export async function variantWriteMark(
	connection: Connection
): Promise<{ mark: string; count: number } | null> {
	try {
		const [row] = await connection
			.collection('product_variants')
			.aggregate<{
				host?: string
				count?: number
				latencyStats?: { writes?: { ops?: unknown }; transactions?: { ops?: unknown } }
			}>([{ $collStats: { latencyStats: {}, count: {} } }], { readPreference: 'primary' })
			.toArray()
		const writes = row?.latencyStats?.writes?.ops
		if (writes === undefined || typeof row?.count !== 'number') return null
		return {
			mark: JSON.stringify([
				row.host ?? null,
				writes,
				row.latencyStats?.transactions?.ops ?? 0,
				row.count
			]),
			count: row.count
		}
	} catch {
		return null
	}
}
