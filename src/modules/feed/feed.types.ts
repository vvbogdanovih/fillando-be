import type { FeedVariantRow } from 'src/database/mongoose/repositories/product-variant.repository'

/** Why a variant was left out of the feed entirely. Each one is a hard Merchant requirement. */
export type FeedExclusionReason =
	| 'missing_brand'
	| 'no_images'
	| 'no_price'
	| 'dangling_product'
	| 'dangling_category'

/** The row is in the feed, but Google will list it worse — or not at all in Shopping. */
export type FeedWarningCode =
	| 'no_google_product_category'
	| 'no_description'
	| 'no_weight'
	| 'missing_required_attribute'

export type FeedAttribute = { k?: string; l?: string; v?: string | number | boolean }

/** One ACTIVE variant with what the feed needs joined in — the shape `findActiveForFeed` returns. */
export type FeedRawRow = FeedVariantRow

export interface FeedExclusion {
	sku: string
	name: string
	reason: FeedExclusionReason
}

export interface FeedWarning {
	code: FeedWarningCode
	count: number
	/** Up to the first 20 SKUs, enough to find the pattern without dumping the catalogue. */
	skus: string[]
	/** For `missing_required_attribute`: which keys were missing, by frequency. */
	detail?: Record<string, number>
}

export interface FeedGenerationSummary {
	generated_at: string
	duration_ms: number
	item_count: number
	in_stock: number
	out_of_stock: number
	/** Items whose product_type was refined by a landing, not just the category name. */
	typed_by_landing: number
	excluded: FeedExclusion[]
	warnings: FeedWarning[]
}

export interface FeedStatus {
	/** False only between process start and the first successful generation. */
	xml_ready: boolean
	generating: boolean
	/** Whether the hourly job is registered in this process (`RUN_CRON`). */
	scheduled: boolean
	/** Public path of the feed, relative to the API origin. */
	feed_path: string
	last_error: string | null
	summary: FeedGenerationSummary | null
}
