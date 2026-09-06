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
	FeedStatus,
	FeedWarning,
	FeedWarningCode
} from './feed.types'
import { resolveProductType, type LandingForProductType } from './product-type.resolver'

/** Enough SKUs per warning to see the pattern; the full list is one aggregate away. */
const WARNING_SKUS_MAX = 20

const CHANNEL_TITLE = 'Fillando'
const CHANNEL_DESCRIPTION = 'Філамент та витратні матеріали для 3D-друку'

/**
 * Builds and caches the Google Shopping feed (TD-0006 §5.3).
 *
 * The XML lives in memory: one `api` instance, regenerated on bootstrap and hourly, served as-is
 * by the public GET. Until the first generation of a process the GET answers 503 with
 * Retry-After — never an empty channel, which Merchant would read as "every item is gone". A
 * failed regeneration keeps the previous XML and records the error for the status screen.
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
			const warnings = new Map<
				FeedWarningCode,
				{ count: number; skus: string[]; detail: Record<string, number> }
			>()
			let inStock = 0
			let outOfStock = 0
			let typedByLanding = 0

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
				for (const code of built.warnings) {
					const entry = warnings.get(code) ?? { count: 0, skus: [], detail: {} }
					entry.count++
					if (entry.skus.length < WARNING_SKUS_MAX) entry.skus.push(row.sku)
					if (code === 'missing_required_attribute') {
						for (const key of built.missing_required) {
							entry.detail[key] = (entry.detail[key] ?? 0) + 1
						}
					}
					warnings.set(code, entry)
				}
			}

			const generatedAt = new Date()
			const xml = buildFeedXml(items, {
				title: CHANNEL_TITLE,
				link: frontendUrl,
				description: CHANNEL_DESCRIPTION,
				generatedAt
			})
			const summary: FeedGenerationSummary = {
				generated_at: generatedAt.toISOString(),
				duration_ms: Date.now() - started,
				item_count: items.length,
				in_stock: inStock,
				out_of_stock: outOfStock,
				typed_by_landing: typedByLanding,
				excluded,
				warnings: [...warnings.entries()].map(
					([code, entry]): FeedWarning => ({
						code,
						count: entry.count,
						skus: entry.skus,
						...(code === 'missing_required_attribute' ? { detail: entry.detail } : {})
					})
				)
			}

			this.cachedXml = xml
			this.generatedAt = generatedAt
			this.lastSummary = summary
			this.lastError = null
			this.logger.log(
				`Google Shopping feed generated: ${items.length} items (${inStock} in stock), ` +
					`${excluded.length} excluded, ${summary.warnings.length} warning kind(s), ${summary.duration_ms} ms`
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
}
