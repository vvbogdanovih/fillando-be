import { Injectable, Logger, MessageEvent } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'
import { ResolvedVendorPrice, resolveShopPrice, resolveVendorPrice } from './prom-pricing'
import { PromProduct, PromService } from './prom.service'

const REQUEST_DELAY_MS = 400

/**
 * How far a price may rise in one sync when Prom reported no discount at all. The vendor runs a
 * rolling promo campaign that it periodically re-creates; in the gap between campaigns Prom
 * reports the bare pre-discount price for the whole catalogue, which would inflate every variant
 * by roughly a third. A rise that large without a discount in the payload is treated as a gap,
 * not as a price change.
 */
const MAX_UNDISCOUNTED_JUMP = 0.15

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface SyncSummary {
	total: number
	processed: number
	updated: number
	/** Subset of `updated` whose price actually changed. */
	pricesUpdated: number
	/** Price writes rejected by the undiscounted-jump guard. */
	priceSkipped: number
	skipped: number
	errors: number
}

@Injectable()
export class PromSyncService {
	private readonly logger = new Logger(PromSyncService.name)
	private running = false

	constructor(
		private readonly promService: PromService,
		private readonly variantRepo: ProductVariantRepository
	) {}

	/** True while a sync (manual or scheduled) is in progress. */
	get isRunning(): boolean {
		return this.running
	}

	/** SSE wrapper around {@link syncAvailability} for the admin endpoint. */
	syncWithProgress(): Observable<MessageEvent> {
		const subject = new Subject<MessageEvent>()

		this.syncAvailability(summary => subject.next({ data: { type: 'progress', ...summary } }))
			.then(summary => {
				subject.next({ data: { type: 'done', ...summary } })
				subject.complete()
			})
			.catch(err => {
				subject.next({ data: { type: 'error', message: err.message } })
				subject.complete()
			})

		return subject.asObservable()
	}

	/**
	 * Core sync routine, reusable by the SSE endpoint and the scheduled job.
	 * For each variant with a `prom_id`, fetches the Prom product and updates stock.
	 * Guards against overlapping runs.
	 */
	async syncAvailability(onProgress?: (summary: SyncSummary) => void): Promise<SyncSummary> {
		if (this.running) {
			throw new Error('Синхронізація наявності вже виконується')
		}
		this.running = true

		try {
			const variants = await this.variantRepo.findAllWithPromId()
			const summary: SyncSummary = {
				total: variants.length,
				processed: 0,
				updated: 0,
				pricesUpdated: 0,
				priceSkipped: 0,
				skipped: 0,
				errors: 0
			}

			this.logger.log(`Starting Prom availability sync for ${variants.length} variants`)
			onProgress?.(summary)

			for (const variant of variants) {
				const v = variant as ProductVariant & { _id: unknown; prom_id?: string }
				const promId = v.prom_id
				const id = v._id

				try {
					const product = promId ? await this.promService.getProduct(promId) : null

					if (!product) {
						summary.skipped++
					} else {
						const { patch, priceRejected } = this.buildPatch(product, v)
						await this.variantRepo.update({ _id: id }, patch)
						summary.updated++
						if (patch.price !== undefined) summary.pricesUpdated++
						if (priceRejected) summary.priceSkipped++
					}
				} catch (err) {
					this.logger.warn(
						`Failed to sync variant ${String(id)} (prom_id ${promId}): ${(err as Error).message}`
					)
					summary.errors++
				}

				summary.processed++
				onProgress?.(summary)
				await sleep(REQUEST_DELAY_MS)
			}

			this.logger.log(`Prom availability sync complete: ${JSON.stringify(summary)}`)
			return summary
		} finally {
			this.running = false
		}
	}

	/**
	 * Build the variant patch for one Prom product: stock always, price whenever it can be
	 * resolved and actually differs.
	 *
	 * The price is recomputed out of stock as well as in — Prom withholds the `discount` object
	 * for out-of-stock listings, so the last discount we saw for the variant is replayed against
	 * the current pre-discount price (see `prom-pricing.ts`). Skipping the write there instead
	 * would freeze whatever price is stored, including a wrong one, for as long as the item stays
	 * unavailable.
	 */
	private buildPatch(
		product: PromProduct,
		variant: ProductVariant
	): { patch: Partial<ProductVariant>; priceRejected: boolean } {
		const now = new Date()
		const stock = this.resolveStock(product)
		const patch: Partial<ProductVariant> = { stock, stock_updated_at: now }

		const resolved = resolveVendorPrice(
			product,
			{ ratio: variant.prom_discount_ratio, seenAt: variant.prom_discount_seen_at },
			stock <= 0,
			now
		)

		if (!resolved) return { patch, priceRejected: false }

		const newPrice = resolveShopPrice(resolved.vendorPrice)

		if (this.isUndiscountedJump(resolved, newPrice, variant)) {
			return { patch, priceRejected: true }
		}

		patch.prom_base_price = product.price ?? null
		patch.price_updated_at = now

		// Only a discount Prom actually reported refreshes the snapshot. Re-stamping it while
		// replaying the remembered one would renew its TTL on every sync, so a variant that never
		// comes back in stock would hold a cancelled promo forever.
		if (resolved.source === 'payload') {
			patch.prom_discount_ratio = resolved.ratio
			patch.prom_discount_seen_at = now
		}

		if (newPrice !== variant.price) patch.price = newPrice

		return { patch, priceRejected: false }
	}

	/**
	 * Whether a price rise came out of a payload with no discount in it and is too steep to be a
	 * genuine vendor price change — the signature of a lapsed promo campaign. When Prom does send
	 * an active discount the computed price is trusted however far it moves.
	 */
	private isUndiscountedJump(
		resolved: ResolvedVendorPrice,
		newPrice: number,
		variant: ProductVariant
	): boolean {
		if (resolved.source !== 'none') return false

		const current = variant.price
		if (typeof current !== 'number' || current <= 0) return false
		if (newPrice <= current * (1 + MAX_UNDISCOUNTED_JUMP)) return false

		this.logger.warn(
			`Skipped price write for ${variant.sku}: ${current} → ${newPrice} ₴ with no discount in the Prom payload`
		)

		return true
	}

	/**
	 * Map Prom availability fields to our numeric stock value.
	 *
	 * `presence` is authoritative — it is the field that drives the availability badge on Prom
	 * itself. `in_stock` is deliberately not used as a veto: Prom returns it as `false` for a
	 * sizeable slice of listings that are `available` with a positive `quantity_in_stock`
	 * (the Tri-Silk / Silk PLA lines among them), which zeroed them out on every sync. It is
	 * only consulted when `presence` is missing from the payload.
	 *
	 * A `quantity_in_stock` of 0 on an available product means Prom is not tracking an exact
	 * number, not that the item ran out — treat it the same as a missing quantity.
	 */
	private resolveStock(product: PromProduct): number {
		const available =
			product.presence !== undefined
				? product.presence !== 'not_available'
				: product.in_stock !== false

		if (!available) return 0

		const qty = product.quantity_in_stock
		return typeof qty === 'number' && qty > 0 ? qty : 1
	}
}
