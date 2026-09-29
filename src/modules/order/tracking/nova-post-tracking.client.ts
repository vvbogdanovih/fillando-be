import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { ENV } from 'src/common/constants'

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/'
/** `getStatusDocuments` accepts up to 100 documents per call. */
const BATCH_SIZE = 100
const BATCH_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 20_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface TrackingQuery {
	ttn: string
	/** Recipient phone, bare digits. Optional: without it Nova Post still returns the status. */
	phone: string
}

export interface TrackingResult {
	code: string
	text: string
}

interface NpStatusDocument {
	Number: string
	StatusCode: string
	Status: string
}

interface NpResponse {
	success: boolean
	data: NpStatusDocument[]
	errors: string[]
}

@Injectable()
export class NovaPostTrackingClient {
	private readonly logger = new Logger(NovaPostTrackingClient.name)

	/**
	 * Current status of each TTN, keyed by TTN. A batch Nova Post refuses is logged and skipped —
	 * its parcels are simply retried on the next run rather than failing the ones that answered.
	 */
	async getStatuses(queries: TrackingQuery[]): Promise<Map<string, TrackingResult>> {
		const results = new Map<string, TrackingResult>()

		for (let start = 0; start < queries.length; start += BATCH_SIZE) {
			if (start > 0) await sleep(BATCH_DELAY_MS)
			const batch = queries.slice(start, start + BATCH_SIZE)

			try {
				const { data } = await axios.post<NpResponse>(
					NP_API_URL,
					{
						apiKey: ENV.NOVA_POS_API_KEY,
						modelName: 'TrackingDocument',
						calledMethod: 'getStatusDocuments',
						methodProperties: {
							Documents: batch.map(q => ({ DocumentNumber: q.ttn, Phone: q.phone }))
						}
					},
					{ timeout: REQUEST_TIMEOUT_MS }
				)

				if (!data.success) {
					this.logger.warn(`Nova Post tracking batch refused: ${data.errors.join('; ')}`)
					continue
				}

				for (const doc of data.data) {
					results.set(doc.Number, { code: String(doc.StatusCode), text: doc.Status })
				}
			} catch (err) {
				this.logger.warn(`Nova Post tracking batch failed: ${(err as Error).message}`)
			}
		}

		return results
	}
}
