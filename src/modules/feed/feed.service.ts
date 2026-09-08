import { ConflictException, Injectable, Logger } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { buildFeedXml, buildItem, SALES_WINDOW_DAYS } from './google-shopping-feed.builder'
import type {
	FeedExclusion,
	FeedGenerationSummary,
	FeedRequiredAttributeGap,
	FeedStatus,
	FeedWarning,
	FeedWarningCode,
	FeedWarningUnit
} from './feed.types'
import { resolveProductType, type LandingForProductType } from './product-type.resolver'

/** Enough SKUs per warning to see the pattern; the full list is one aggregate away. */
const WARNING_SKUS_MAX = 20

const CHANNEL_TITLE = 'Fillando'
const CHANNEL_DESCRIPTION = 'Філамент та витратні матеріали для 3D-друку'

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
 * Builds and caches the Google Shopping feed (TD-0006 §5.3).
 *
 * The XML lives in memory: one `api` instance, regenerated on bootstrap and hourly, served as-is
 * by the public GET. Until the first generation of a process the GET answers 503 with
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
	private cachedXml: string | null = null
	private generatedAt: Date | null = null
	private lastSummary: FeedGenerationSummary | null = null
	private lastError: string | null = null
	/** Set by the cron service once the hourly job is registered in this process. */
	scheduled = false

	constructor(
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly landingRepository: LandingRepository,
		private readonly orderRepository: OrderRepository
	) {}

	get isRunning(): boolean {
		return this.generating
	}

	/** The last good XML, or null before the first generation of this process. */
	getXml(): { xml: string; generatedAt: Date } | null {
		if (!this.cachedXml || !this.generatedAt) return null
		return { xml: this.cachedXml, generatedAt: this.generatedAt }
	}

	getStatus(): FeedStatus {
		return {
			xml_ready: this.cachedXml !== null,
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

		try {
			const since = new Date(Date.now() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000)
			const [rows, landings, unitsSold] = await Promise.all([
				this.productVariantRepository.findActiveForFeed(),
				this.landingRepository.findActive(),
				this.orderRepository.countSoldByVariantSince(since)
			])
			const landingViews: LandingForProductType[] = landings.map(l => ({
				category_id: String(l.category_id),
				h1: l.h1,
				order: l.order ?? 0,
				filters: l.filters ?? {}
			}))
			const frontendUrl = ENV.FRONTEND_URL.replace(/\/$/, '')

			const items: string[] = []
			const excluded: FeedExclusion[] = []
			const warnings = new Map<FeedWarningCode, WarningAccumulator>()
			let inStock = 0
			let outOfStock = 0
			let typedByLanding = 0
			let warnedItems = 0

			for (const row of rows) {
				const typed =
					row.category && row.product
						? resolveProductType(
								row.category.name,
								row.category.id,
								row.product.attributes ?? [],
								landingViews
							)
						: { product_type: '', landing: null }
				const built = buildItem(row, {
					frontendUrl,
					productType: typed.product_type,
					unitsSold: unitsSold.get(row.id) ?? 0
				})
				if (!built.ok) {
					excluded.push({ sku: row.sku, name: row.name, reason: built.reason })
					continue
				}
				items.push(built.xml)
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

			const generatedAt = new Date()
			const warningList = [...warnings.entries()].map(([code, entry]) =>
				this.toWarning(code, entry)
			)
			const summary: FeedGenerationSummary = {
				ok: items.length > 0,
				failure_reason: items.length > 0 ? null : 'empty_feed',
				error: null,
				generated_at: generatedAt.toISOString(),
				duration_ms: Date.now() - started,
				item_count: items.length,
				in_stock: inStock,
				out_of_stock: outOfStock,
				typed_by_landing: typedByLanding,
				excluded,
				warnings: warningList,
				warning_kinds: warningList.length,
				warned_items: warnedItems
			}

			// Zero items is a data failure, not a catalogue of nothing: a valid empty channel makes
			// Merchant delist every product. So nothing is published — whatever is cached stays,
			// and with an empty cache the public GET keeps answering 503.
			if (items.length === 0) {
				summary.error = this.emptyFeedError(rows.length, excluded.length)
				this.lastError = summary.error
				this.logger.error(`Google Shopping feed not published: ${summary.error}`)
				return summary
			}

			this.cachedXml = buildFeedXml(items, {
				title: CHANNEL_TITLE,
				link: frontendUrl,
				description: CHANNEL_DESCRIPTION,
				generatedAt
			})
			this.generatedAt = generatedAt
			this.lastSummary = summary
			this.lastError = null
			this.logger.log(
				`Google Shopping feed generated: ${items.length} items (${inStock} in stock), ` +
					`${excluded.length} excluded, ${summary.warning_kinds} warning kind(s) over ` +
					`${summary.warned_items} item(s), ${summary.duration_ms} ms`
			)
			return summary
		} catch (err) {
			this.lastError = (err as Error).message
			this.logger.error(`Google Shopping feed generation failed: ${this.lastError}`)
			throw err
		} finally {
			this.generating = false
		}
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
		return this.cachedXml
			? `Фід не оновлено: генерація дала 0 позицій (${scanned}). Merchant отримує попередній XML.`
			: `Фід не згенеровано: генерація дала 0 позицій (${scanned}). Публічний запит відповідає 503.`
	}
}
