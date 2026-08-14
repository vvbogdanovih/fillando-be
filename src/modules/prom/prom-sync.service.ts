import { Injectable, Logger, MessageEvent } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'
import { resolveShopPrice, resolveVendorPrice } from './prom-pricing'
import { PromProduct, PromService } from './prom.service'

const REQUEST_DELAY_MS = 400

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface SyncSummary {
	total: number
	processed: number
	updated: number
	/** Subset of `updated` whose price actually changed. */
	pricesUpdated: number
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
						const patch = this.buildPatch(product, v.price)
						await this.variantRepo.update({ _id: id }, patch)
						summary.updated++
						if (patch.price !== undefined) summary.pricesUpdated++
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
	 * Build the variant patch for one Prom product: stock always, price only when it can be
	 * trusted and actually differs.
	 *
	 * **Price is only read while the product is in stock.** Prom drops the `discount` object the
	 * moment an item goes out of stock and reports the pre-discount `price` instead — pricing off
	 * that would inflate the variant by the discount amount. Out of stock, the last known price is
	 * left as it is.
	 */
	private buildPatch(product: PromProduct, currentPrice: number): Partial<ProductVariant> {
		const now = new Date()
		const stock = this.resolveStock(product)
		const patch: Partial<ProductVariant> = { stock, stock_updated_at: now }

		if (stock <= 0) return patch

		const vendorPrice = resolveVendorPrice(product, now)
		if (vendorPrice === null) return patch

		patch.price_updated_at = now

		const newPrice = resolveShopPrice(vendorPrice)
		if (newPrice !== currentPrice) patch.price = newPrice

		return patch
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
