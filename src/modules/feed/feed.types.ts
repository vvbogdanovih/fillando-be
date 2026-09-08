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

/**
 * What a warning's `count` counts. Most warnings are a property of the feed row, but a missing
 * `google_product_category` is a property of the category — one untagged category with forty
 * variants is one problem to fix, not forty.
 */
export type FeedWarningUnit = 'item' | 'category'

/** Why a generation published nothing. `empty_feed`: zero items, so the cache was left alone. */
export type FeedGenerationFailureReason = 'empty_feed'

export type FeedAttribute = { k?: string; l?: string; v?: string | number | boolean }

/** One required attribute of a category, with the label the admin screen prints. */
export interface FeedRequiredAttributeRef {
	key: string
	/** «Діаметр», not `diameter`; falls back to the key only when neither source carries a label. */
	label: string
}

export interface FeedRequiredAttributeGap extends FeedRequiredAttributeRef {
	/** Feed rows whose category requires this attribute and whose value is missing or empty. */
	count: number
}

/** One ACTIVE variant with what the feed needs joined in — the shape `findActiveForFeed` returns. */
export type FeedRawRow = FeedVariantRow

export interface FeedExclusion {
	sku: string
	name: string
	reason: FeedExclusionReason
}

export interface FeedWarning {
	code: FeedWarningCode
	/** Affected entities, counted in `unit` — read the two together, never `count` alone. */
	count: number
	unit: FeedWarningUnit
	/** Feed rows carrying this warning, whatever `unit` counts. */
	item_count: number
	/** Up to the first 20 SKUs, enough to find the pattern without dumping the catalogue. */
	skus: string[]
	/** For `missing_required_attribute`: which keys were unfulfilled, by frequency. */
	detail?: Record<string, number>
	/** The same gaps with their labels, so no screen has to guess a human name for a key. */
	attributes?: FeedRequiredAttributeGap[]
}

export interface FeedGenerationSummary {
	/** False when the run published nothing — check it before reading any count below. */
	ok: boolean
	/** What stopped the publish; null when `ok`. */
	failure_reason: FeedGenerationFailureReason | null
	/** The text also recorded in `FeedStatus.last_error`; null when `ok`. */
	error: string | null
	/** When `ok` is false this is the time of the attempt, not of a publish. */
	generated_at: string
	duration_ms: number
	item_count: number
	in_stock: number
	out_of_stock: number
	/** Items whose product_type was refined by a landing, not just the category name. */
	typed_by_landing: number
	excluded: FeedExclusion[]
	warnings: FeedWarning[]
	/** Distinct warning kinds — the admin KPI counts kinds, not affected positions. */
	warning_kinds: number
	/** Feed rows carrying at least one warning, counted once however many they carry. */
	warned_items: number
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
	/** The summary of the XML currently served — a refused publish never replaces it. */
	summary: FeedGenerationSummary | null
}
