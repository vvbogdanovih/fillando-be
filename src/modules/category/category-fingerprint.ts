import type { Connection, mongo } from 'mongoose'

/**
 * A mark of every write to one collection, read in O(1) (Plan-0010 D06): the collection's own
 * operation counters (`$collStats` latency stats — insert, update incl. no-op and unmatched ones,
 * replace, findAndModify, bulk, delete, transactions — from any client: the API, the CLI, a raw
 * script), its document count, its UUID (a drop and re-create, a rename over it or an `$out`
 * replace it) and the server process (`hello` → `topologyVersion.processId`: a restart resets the
 * counters, a failover changes the primary). Read before the data it guards, it changes after any
 * such write acknowledged in between. ~1 ms, three small commands in parallel.
 *
 * **Not seen: `$merge` into the collection** (measured on MongoDB 7 and 8 — its writes reach no
 * counter and, when they replace documents, no count). A memo keyed by the mark is therefore
 * also bounded by time (`CATEGORY_MEMO_MS`). `null` when the server does not report the counters
 * (callers fall back to the full pass).
 */
export async function collectionWriteMark(
	connection: Connection,
	name: string
): Promise<string | null> {
	try {
		const db = connection.db
		if (!db) return null
		const [stats, collections, hello] = await Promise.all([
			db
				.collection(name)
				.aggregate<{
					host?: string
					count?: number
					latencyStats?: { writes?: { ops?: unknown }; transactions?: { ops?: unknown } }
				}>([{ $collStats: { latencyStats: {}, count: {} } }], { readPreference: 'primary' })
				.toArray(),
			db.listCollections({ name }, { nameOnly: false }).toArray(),
			db.command({ hello: 1 })
		])
		const [row] = stats
		const writes = row?.latencyStats?.writes?.ops
		const uuid = (collections[0] as { info?: { uuid?: mongo.UUID } } | undefined)?.info?.uuid
		const process = (hello as { topologyVersion?: { processId?: unknown } }).topologyVersion
			?.processId
		if (writes === undefined || typeof row?.count !== 'number' || !uuid || !process) return null
		// The counters may be numbers or Longs, the process id an ObjectId: all serialise as JSON.
		return JSON.stringify([
			row.host ?? null,
			process,
			uuid.toHexString(),
			writes,
			row.latencyStats?.transactions?.ops ?? 0,
			row.count
		])
	} catch {
		return null
	}
}

/**
 * The categories fingerprint a parsed tree is reused under: the O(1) write mark when the server
 * reports it, otherwise a content hash of the whole collection (`hashFingerprint`). Every reader of
 * the tree keys its memo on it (Plan-0010 D06): the full pass cost ~70 ms at 10 000 categories and
 * ~1 s at 150 000 — per request.
 */
export async function categoryFingerprint(connection: Connection): Promise<string | null> {
	const mark = await collectionWriteMark(connection, 'categories')
	return mark !== null ? `mark:${mark}` : hashFingerprint(connection)
}

/**
 * A content fingerprint of the whole `categories` collection, computed by the server in one pass
 * (count plus the sum of `$toHashedIndexKey` of every document): any write — journal, legacy
 * Mongoose, a raw script, `$merge` included — changes it. The fallback of
 * {@link categoryFingerprint} for a server without `$collStats` latency counters.
 * `null` on a server without the operator; callers then simply do not memoise.
 *
 * Concurrent callers share one pass, but only a pass that **started after they called**: a caller
 * that arrives while a pass is running waits for the next one, which every such caller shares. So a
 * write acknowledged before the call is always reflected, and at 10 concurrent catalogue reads the
 * server hashes the collection about once per pass instead of once per request (Plan-0010 D06).
 */
let unsupported = false
const passes = new WeakMap<
	Connection,
	{ running: Promise<string | null> | null; next: Promise<string | null> | null }
>()
export function hashFingerprint(connection: Connection): Promise<string | null> {
	if (unsupported) return Promise.resolve(null)
	let state = passes.get(connection)
	if (!state) passes.set(connection, (state = { running: null, next: null }))
	const current = state
	// Queued, not started yet: it starts after this call, so it may be shared.
	if (current.next) return current.next
	const start = () => {
		const pass = computeFingerprint(connection)
		current.running = pass
		const settle = () => {
			if (current.running === pass) current.running = null
		}
		pass.then(settle, settle)
		return pass
	}
	if (!current.running) return start()
	// A running pass may have read the collection before this call: wait for the next one.
	const next = current.running
		.catch(() => undefined)
		.then(() => {
			current.next = null
			return start()
		})
	current.next = next
	return next
}

async function computeFingerprint(connection: Connection): Promise<string | null> {
	if (unsupported) return null
	try {
		const [row] = await connection
			.collection('categories')
			.aggregate<{ count: number; hash: number | mongo.Long }>(
				[
					{
						$group: {
							_id: null,
							count: { $sum: 1 },
							hash: { $sum: { $toHashedIndexKey: '$$ROOT' } }
						}
					}
				],
				{ readPreference: 'primary' }
			)
			.toArray()
		return `${row?.count ?? 0}:${(row?.hash ?? 0).toString()}`
	} catch (error) {
		// 168 InvalidPipelineOperator / 15952 unknown group operator: an older server.
		if ([168, 15952].includes((error as { code?: number }).code ?? 0)) {
			unsupported = true
			return null
		}
		throw error
	}
}

/** A parsed result is reused at most this long even while the fingerprint holds. */
export const CATEGORY_MEMO_MS = 60_000
