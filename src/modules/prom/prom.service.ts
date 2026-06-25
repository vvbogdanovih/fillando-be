import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { ENV } from 'src/common/constants'

const PROM_API_BASE = 'https://my.prom.ua/api/v1'
const HTTP_TIMEOUT_MS = 20000
const RETRY_DELAY_MS = 3000
const MAX_RETRIES = 3

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface PromProduct {
	id: number
	name?: string
	sku?: string
	presence?: string
	quantity_in_stock?: number | null
	in_stock?: boolean
	status?: string
}

@Injectable()
export class PromService {
	private readonly logger = new Logger(PromService.name)

	/**
	 * Fetch a single product from the Prom public API by its Prom id.
	 * Returns null when the product does not exist (404). Retries on 429 /
	 * 5xx / network errors with a linear backoff, and throws if they persist.
	 */
	async getProduct(promId: string): Promise<PromProduct | null> {
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const { data } = await axios.get<{ product: PromProduct }>(
					`${PROM_API_BASE}/products/${promId}`,
					{
						headers: { Authorization: `Bearer ${ENV.PROM_API_KEY}` },
						timeout: HTTP_TIMEOUT_MS
					}
				)
				return data?.product ?? null
			} catch (err) {
				const status = axios.isAxiosError(err) ? err.response?.status : undefined

				if (status === 404) {
					this.logger.warn(`Prom product ${promId} not found (404)`)
					return null
				}

				const retriable =
					status === 429 ||
					status === undefined ||
					(status !== undefined && status >= 500)

				if (retriable && attempt < MAX_RETRIES) {
					this.logger.warn(
						`Prom fetch ${promId} failed (status ${status ?? 'network'}), retry ${attempt}/${MAX_RETRIES}`
					)
					await sleep(RETRY_DELAY_MS * attempt)
					continue
				}

				throw err
			}
		}

		return null
	}
}
