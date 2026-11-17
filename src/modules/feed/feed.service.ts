import { once } from 'node:events'
import { createGzip, gunzipSync } from 'node:zlib'
import { LegacyCatalogWritePolicy } from '../catalog-safety/legacy-catalog-write.interceptor'
import {
	ConflictException,
	Injectable,
	Logger,
	Optional,
	ServiceUnavailableException
} from '@nestjs/common'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { adaptFeedRow, type FeedCategory } from './feed-typed-adapter'
import { ENV } from 'src/common/constants'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import {
	buildItem,
	FEED_XML_TAIL,
	feedXmlHead,
	SALES_WINDOW_DAYS
} from './google-shopping-feed.builder'
import type {
	FeedExclusion,
	FeedExclusionReason,
	FeedGenerationSummary,
	FeedRawRow,
	FeedRequiredAttributeGap,
	FeedStatus,
	FeedWarning,
	FeedWarningCode,
	FeedWarningUnit
} from './feed.types'
import {
	resolveProductType,
	typedLandingPins,
	type LandingForProductType
} from './product-type.resolver'

/** Enough SKUs per warning to see the pattern; the full list is one aggregate away. */
const WARNING_SKUS_MAX = 20
/**
 * Exclusions listed by SKU in the summary; `excluded_count` / `excluded_by_reason` count them all.
 * Far above any real catalogue's count, so the admin screen keeps listing every one of them —
 * only a synthetic 100 000-row collapse is cut (Plan-0010 D06).
 */
export const FEED_EXCLUSION_SAMPLE = 500
/** Items reach the compressor in slices of about this many characters, not one call per item. */
const FLUSH_CHARS = 64 * 1024
/** Rows built together: the v2 definitions their categories need are read in one query. */
const ROW_BATCH = 100
/**
 * v2 categories whose definitions a generation keeps at once. SKUs come in SKU order, which in
 * practice runs product by product, so a small window hits; a miss is one query per row batch.
 */
const DEFINITIONS_KEPT = 500

const CHANNEL_TITLE = 'Fillando'
const CHANNEL_DESCRIPTION = 'Каталог товарів Fillando'

/**
 * What each warning kind counts. Everything except the taxonomy gap is a property of the feed
 * row; a missing `google_product_category` is a property of the category, so counting rows made
 * one untagged category with forty variants report «40» under a label that says «категорія».
 * A `Record` over the code union forces a new warning kind to declare its unit.
 */
const WARNING_UNIT: Record<FeedWarningCode, FeedWarningUnit> = {
	no_google_product_category: 'category',
	no_description: 'item',
	no_weight: 'item',
	missing_required_attribute: 'item'
}

/** Per-code accumulator: rows, the categories those rows belong to, and the attribute gaps. */
interface WarningAccumulator {
	items: number
	skus: string[]
	categories: Set<string>
	gaps: Map<string, FeedRequiredAttributeGap>
}

/**
 * The feed as served: the exact XML bytes, kept gzip-compressed — ~150 MB of text at 100 000
 * items is a few MiB this way (Plan-0010 D06). The GET inflates it as it sends it.
 */
export interface FeedArtifact {
	gzip: Buffer
	/** Byte length of the XML itself — the response's `Content-Length`. */
	bytes: number
	generatedAt: Date
}

/** An artifact's XML as one string — for specs and diagnostics; the GET streams it instead. */
export const feedXmlOf = (artifact: FeedArtifact): string =>
	gunzipSync(artifact.gzip).toString('utf8')

/**
 * Compresses the XML while it is produced, so the document never exists as one string: the
 * previous generation kept every item string, joined them and kept the result (Plan-0010 D06).
 */
class CompressedXml {
	private readonly gzip = createGzip()
	private readonly chunks: Buffer[] = []
	private readonly ended: Promise<void>
	private pending = ''
	/** UTF-8 bytes written so far. */
	bytes = 0

	constructor() {
		this.gzip.on('data', (chunk: Buffer) => this.chunks.push(chunk))
		this.ended = new Promise<void>((resolve, reject) => {
			this.gzip.once('end', resolve)
			this.gzip.once('error', reject)
		})
		// Observed by `finish`; a discarded writer must not leave an unhandled rejection.
		this.ended.catch(() => undefined)
	}

	async write(text: string): Promise<void> {
		this.pending += text
		this.bytes += Buffer.byteLength(text)
		if (this.pending.length >= FLUSH_CHARS) await this.flush()
	}

	async finish(): Promise<Buffer> {
		await this.flush()
		this.gzip.end()
		await this.ended
		return Buffer.concat(this.chunks)
	}

	discard(): void {
		this.gzip.destroy()
	}

	private async flush(): Promise<void> {
		const text = this.pending
		this.pending = ''
		if (text && !this.gzip.write(text)) await once(this.gzip, 'drain')
	}
}

/**
 * Builds and caches the Google Shopping feed (TD-0006 §5.3).
 *
 * The XML lives in memory, compressed ({@link FeedArtifact}): one `api` instance, regenerated on
 * bootstrap and hourly, served byte for byte by the public GET. The working set is read through a
 * cursor and the XML compressed as it is built, so neither the rows nor the document are ever held
 * whole — 518 MiB at 100 000 SKUs otherwise (Plan-0010 D06). Until the first generation of a process the GET answers 503 with
 * Retry-After — never an empty channel, which Merchant would read as "every item is gone". A
 * failed regeneration keeps the previous XML and records the error for the status screen.
 *
 * A run that yields zero items counts as a failure for exactly the same reason: it is refused,
 * not published, so the cache never becomes an empty channel. `FeedGenerationSummary.ok` says
 * which of the two happened, and `lastSummary` keeps describing the XML actually being served.
 */
@Injectable()
export class FeedService {
	private readonly logger = new Logger(FeedService.name)

	/** Guards against two overlapping aggregations — the manual button plus the cron. */
	private generating = false
	/**
	 * A rebuild asked for while one was already running (TD-0012). The running one started from
	 * a read that predates the request, so it may well publish the very state the request wanted
	 * gone — the request is kept and honoured as soon as that run ends, whoever started it: the
	 * cron, the bootstrap, or the admin's manual button. That is why the flag lives here and not
	 * in the cron service, which never sees the manual run.
	 */
	private rerunRequested = false
	private cached: FeedArtifact | null = null
	private cachedStamp: Awaited<ReturnType<LegacyCatalogWritePolicy['beginRead']>> | null = null
	private lastSummary: FeedGenerationSummary | null = null
	private lastError: string | null = null
	/** Set by the cron service once the hourly job is registered in this process. */
	scheduled = false

	constructor(
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly landingRepository: LandingRepository,
		private readonly orderRepository: OrderRepository,
		private readonly catalogPolicy: LegacyCatalogWritePolicy,
		/**
		 * Public category projection (TD-0013). With it the feed is an adapted reader: only SKUs
		 * of public categories are exported and v2 rows are formatted from their definitions.
		 * Without it (unit specs) the legacy barrier applies unchanged.
		 */
		@Optional() private readonly publicCategories?: CategoryPublicReadService
	) {}

	private get adapted() {
		return this.publicCategories !== undefined
	}

	get isRunning(): boolean {
		return this.generating
	}

	/**
	 * "Rebuild once the current generation ends." A no-op when nothing is running — the caller
	 * then simply calls {@link generate} itself.
	 */
	requestRerun(): void {
		if (!this.generating) return
		this.rerunRequested = true
	}

	/** The last good feed, or null before the first generation of this process. */
	getXml(): FeedArtifact | null {
		return this.cached
	}

	/**
	 * Public delivery must validate the generation stamp, including after a completed migration.
	 * A stale stamp also queues a rebuild: a catalogue write from another process (the release
	 * CLI's apply) raises no signal here, and with `RUN_CRON` off during the release
	 * window nothing else would rebuild before a restart — Merchant would keep getting the 503.
	 *
	 * Stale means another **revision**: only a completed operation changes catalogue data
	 * (`publishVerified`), and it moves both counters. An aborted operation wrote nothing and a
	 * rolled-back one restored every before-image, so the epoch they move alone leaves the feed
	 * true — it answered 503 after every refused or unchanged save until a rebuild (audit 11.11).
	 * A write landing mid-generation is still caught by the generation's own read barrier.
	 */
	async getVerifiedXml() {
		const stamp = await this.catalogPolicy.beginRead(this.adapted)
		const cached = this.getXml()
		const generatedStamp = this.cachedStamp
		if (
			cached &&
			(!generatedStamp ||
				generatedStamp.initialized !== stamp.initialized ||
				generatedStamp.revision !== stamp.revision)
		) {
			feedRefresh.request('stale catalogue stamp')
			throw new ServiceUnavailableException({
				message: 'Feed regeneration required',
				details: { code: 'CATALOG_FEED_STALE' }
			})
		}
		await this.catalogPolicy.finishRead(stamp, this.adapted)
		return cached
	}

	getStatus(): FeedStatus {
		return {
			xml_ready: this.cached !== null,
			generating: this.generating,
			scheduled: this.scheduled,
			feed_path: `${ENDPOINTS.FEEDS.BASE}${ENDPOINTS.FEEDS.GOOGLE_SHOPPING_XML}`,
			last_error: this.lastError,
			summary: this.lastSummary
		}
	}

	async generate(): Promise<FeedGenerationSummary> {
		if (this.generating) {
			throw new ConflictException('Фід уже генерується, спробуйте через хвилину')
		}
		this.generating = true
		const started = Date.now()

		const xml = new CompressedXml()
		try {
			const catalogStamp = await this.catalogPolicy.beginRead(this.adapted)
			const since = new Date(Date.now() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000)
			const [allLandings, unitsSold, publicCategories] = await Promise.all([
				this.landingRepository.findActive(),
				this.orderRepository.countSoldByVariantSince(since),
				// Visibility and contract only; the definitions are read per row batch (Plan-0010 D06).
				this.publicCategories?.productCategories() ?? Promise.resolve(null)
			])
			// Adapted: a SKU is exported only under a public category; landings only under a
			// public v1 category, or a public v2 one when the landing has typed pins.
			const visible = publicCategories
				? new Map(publicCategories.map(category => [category._id, category]))
				: null
			const landings = visible
				? allLandings.filter(landing => {
						const version = visible.get(
							String(landing.category_id)
						)?.attribute_contract_version
						return version === 1 || (version === 2 && landing.contract_version === 2)
					})
				: allLandings
			// A typed landing types `product_type` by its own pins (`filters_v2`) against the typed
			// values — what the storefront lists under it — never by legacy pins a re-pinned or
			// new landing does not have; one it cannot evaluate per row does not refine the type.
			const landingViews = landings.flatMap((l): LandingForProductType[] => {
				const base = { category_id: String(l.category_id), h1: l.h1, order: l.order ?? 0 }
				if (l.contract_version !== 2) return [{ ...base, filters: l.filters ?? {} }]
				const pins = typedLandingPins(l.filters_v2)
				return pins ? [{ ...base, pins }] : []
			})
			const frontendUrl = ENV.FRONTEND_URL.replace(/\/$/, '')
			// One instant for the whole feed, and the one it is stamped with: every item decides
			// its promotion against the same clock (TD-0012).
			const generatedAt = new Date()

			await xml.write(
				feedXmlHead({
					title: CHANNEL_TITLE,
					link: frontendUrl,
					description: CHANNEL_DESCRIPTION,
					generatedAt
				})
			)
			const excluded: FeedExclusion[] = []
			const excludedByReason: Partial<Record<FeedExclusionReason, number>> = {}
			const warnings = new Map<FeedWarningCode, WarningAccumulator>()
			let rowCount = 0
			let itemCount = 0
			let excludedCount = 0
			let inStock = 0
			let outOfStock = 0
			let typedByLanding = 0
			let warnedItems = 0

			// v2 definitions of the categories met so far, least recently used first; bounded.
			const definitions = new Map<string, FeedCategory>()
			const typedOf = async (rows: FeedRawRow[]) => {
				const missing = new Set<string>()
				for (const raw of rows) {
					const node = raw.category && visible?.get(raw.category.id)
					if (node?.attribute_contract_version !== 2) continue
					const kept = definitions.get(node._id)
					if (kept) {
						definitions.delete(node._id)
						definitions.set(node._id, kept)
					} else missing.add(node._id)
				}
				if (!missing.size) return
				// Read against the same tree, past the storefront's cache (`cache: false`).
				const content = await this.publicCategories!.contentOf(missing, {
					cache: false,
					of: publicCategories!
				})
				for (const [id, category] of content) {
					definitions.set(id, {
						_id: category._id,
						name: category.name,
						attribute_contract_version: category.attribute_contract_version,
						attribute_definitions: category.attribute_definitions
					})
					if (definitions.size > DEFINITIONS_KEPT)
						definitions.delete(definitions.keys().next().value as string)
				}
			}
			const categoryOf = (id: string): FeedCategory | undefined => {
				const node = visible?.get(id)
				if (!node) return undefined
				return node.attribute_contract_version === 2
					? definitions.get(id)
					: { ...node, attribute_definitions: [] }
			}

			// Grouped products (more than one active variant) by id — not the rows themselves.
			const grouped = await this.productVariantRepository.findGroupedProductIds()
			// SKU order, a row batch at a time: neither the rows nor the built items are kept.
			const cursor = this.productVariantRepository.findActiveForFeed()
			let batch: FeedRawRow[] = []
			const rowsOf = async function* () {
				for await (const raw of cursor) {
					batch.push(raw)
					if (batch.length < ROW_BATCH) continue
					await typedOf(batch)
					yield* batch
					batch = []
				}
				await typedOf(batch)
				yield* batch
			}
			for await (const raw of rowsOf()) {
				let row: FeedRawRow = raw
				if (visible) {
					const category = raw.category ? categoryOf(raw.category.id) : undefined
					if (!category) continue
					row = adaptFeedRow(raw, category)
				}
				rowCount++
				const axisKey = row.product?.variant_axis?.key
				const typed =
					row.category && row.product
						? resolveProductType(
								row.category.name,
								row.category.id,
								row.product.attributes ?? [],
								landingViews,
								[
									...(row.product.attributes_v2 ?? []),
									...(axisKey && row.variant_value != null
										? [{ k: axisKey, v: row.variant_value }]
										: [])
								]
							)
						: { product_type: '', landing: null }
				const built = buildItem(row, {
					frontendUrl,
					productType: typed.product_type,
					inGroup: grouped.has(row.product_id),
					unitsSold: unitsSold.get(row.id) ?? 0,
					now: generatedAt
				})
				if (!built.ok) {
					excludedCount++
					excludedByReason[built.reason] = (excludedByReason[built.reason] ?? 0) + 1
					if (excluded.length < FEED_EXCLUSION_SAMPLE)
						excluded.push({ sku: row.sku, name: row.name, reason: built.reason })
					continue
				}
				await xml.write(`${built.xml}\n`)
				itemCount++
				if (typed.landing) typedByLanding++
				if ((row.stock ?? 0) > 0) inStock++
				else outOfStock++
				if (built.warnings.length > 0) warnedItems++
				for (const code of built.warnings) {
					const entry: WarningAccumulator = warnings.get(code) ?? {
						items: 0,
						skus: [],
						categories: new Set(),
						gaps: new Map()
					}
					entry.items++
					if (row.category) entry.categories.add(row.category.id)
					if (entry.skus.length < WARNING_SKUS_MAX) entry.skus.push(row.sku)
					if (code === 'missing_required_attribute') {
						for (const ref of built.missing_required) {
							const gap = entry.gaps.get(ref.key) ?? { ...ref, count: 0 }
							gap.count++
							// A later row may carry the label where an earlier one had only the key.
							if (gap.label === gap.key && ref.label !== ref.key)
								gap.label = ref.label
							entry.gaps.set(ref.key, gap)
						}
					}
					warnings.set(code, entry)
				}
			}

			const warningList = [...warnings.entries()].map(([code, entry]) =>
				this.toWarning(code, entry)
			)
			const summary: FeedGenerationSummary = {
				ok: itemCount > 0,
				failure_reason: itemCount > 0 ? null : 'empty_feed',
				error: null,
				generated_at: generatedAt.toISOString(),
				duration_ms: Date.now() - started,
				item_count: itemCount,
				in_stock: inStock,
				out_of_stock: outOfStock,
				typed_by_landing: typedByLanding,
				excluded,
				excluded_count: excludedCount,
				excluded_by_reason: excludedByReason,
				warnings: warningList,
				warning_kinds: warningList.length,
				warned_items: warnedItems
			}

			// Zero items is a data failure, not a catalogue of nothing: a valid empty channel makes
			// Merchant delist every product. So nothing is published — whatever is cached stays,
			// and with an empty cache the public GET keeps answering 503.
			if (itemCount === 0) {
				xml.discard()
				await this.catalogPolicy.finishRead(catalogStamp, this.adapted)
				summary.error = this.emptyFeedError(rowCount, excludedCount)
				this.lastError = summary.error
				this.logger.error(`Google Shopping feed not published: ${summary.error}`)
				return summary
			}

			await xml.write(FEED_XML_TAIL)
			const gzip = await xml.finish()
			summary.duration_ms = Date.now() - started
			await this.catalogPolicy.finishRead(catalogStamp, this.adapted)
			// Publish the verified artifact synchronously, with no awaits between its fields.
			this.cached = { gzip, bytes: xml.bytes, generatedAt }
			this.cachedStamp = catalogStamp
			this.lastSummary = summary
			this.lastError = null
			this.logger.log(
				`Google Shopping feed generated: ${itemCount} items (${inStock} in stock), ` +
					`${excludedCount} excluded, ${summary.warning_kinds} warning kind(s) over ` +
					`${summary.warned_items} item(s), ${xml.bytes} bytes (${gzip.length} stored), ` +
					`${summary.duration_ms} ms`
			)
			return summary
		} catch (err) {
			xml.discard()
			this.lastError = (err as Error).message
			this.logger.error(`Google Shopping feed generation failed: ${this.lastError}`)
			throw err
		} finally {
			this.generating = false
			this.runRerunIfRequested()
		}
	}

	private runRerunIfRequested(): void {
		if (!this.rerunRequested) return
		this.rerunRequested = false
		this.logger.log('Google Shopping feed: running the rebuild requested during the last run')
		void this.generate().catch((err: Error) => {
			// Already logged by `generate`; here only so the rerun can never become an unhandled
			// rejection — the run that is over does not care how its follower ends.
			this.logger.error(`Queued Google Shopping feed rebuild failed: ${err.message}`)
		})
	}

	/** One summary row: `count` in the kind's own unit, `item_count` always in feed rows. */
	private toWarning(code: FeedWarningCode, entry: WarningAccumulator): FeedWarning {
		const unit = WARNING_UNIT[code]
		const gaps = [...entry.gaps.values()].sort((a, b) => b.count - a.count)
		return {
			code,
			count: unit === 'category' ? entry.categories.size : entry.items,
			unit,
			item_count: entry.items,
			skus: entry.skus,
			...(code === 'missing_required_attribute'
				? {
						detail: Object.fromEntries(gaps.map(g => [g.key, g.count])),
						attributes: gaps
					}
				: {})
		}
	}

	/** Status-screen text for a refused publish: what was scanned, and what Merchant gets now. */
	private emptyFeedError(rowCount: number, excludedCount: number): string {
		const scanned = `рядків каталогу: ${rowCount}, виключено: ${excludedCount}`
		return this.cached
			? `Фід не оновлено: генерація дала 0 позицій (${scanned}). Попередній XML збережено; видача залежить від перевірки стану каталогу.`
			: `Фід не згенеровано: генерація дала 0 позицій (${scanned}). Публічний запит відповідає 503.`
	}
}
