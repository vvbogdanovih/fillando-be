import { Injectable, Logger, MessageEvent } from '@nestjs/common'
import axios from 'axios'
import { Observable, Subject } from 'rxjs'
import { ENV } from 'src/common/constants'
import { NovaPostCityRepository } from 'src/database/mongoose/repositories/nova-post-city.repository'
import { NovaPostWarehouseRepository } from 'src/database/mongoose/repositories/nova-post-warehouse.repository'
import { NovaPostCity } from 'src/database/mongoose/schemas/nova-post-city.schema'
import { NovaPostWarehouse } from 'src/database/mongoose/schemas/nova-post-warehouse.schema'

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/'
const CITIES_PAGE_SIZE = 150
const WAREHOUSES_PAGE_SIZE = 500
const REQUEST_DELAY_MS = 300
const RETRY_DELAY_MS = 3000
const MAX_RETRIES = 3

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface NpApiResponse<T> {
	success: boolean
	data: T[]
	errors: string[]
}

interface NpCity {
	Ref: string
	Description: string
	SettlementType: string
	AreaDescription: string
}

interface NpWarehouse {
	Ref: string
	Description: string
	ShortAddress: string
	Number: string
	CityRef: string
	CityDescription: string
	TotalMaxWeightAllowed: string
	TypeOfWarehouse: string
	PostalCodeUA: string
}

export interface SyncProgressEvent {
	type: 'progress' | 'done' | 'error'
	entity?: 'cities' | 'warehouses'
	synced?: number
	cities?: number
	warehouses?: number
	message?: string
}

@Injectable()
export class NovaPostSyncService {
	private readonly logger = new Logger(NovaPostSyncService.name)

	constructor(
		private readonly cityRepo: NovaPostCityRepository,
		private readonly warehouseRepo: NovaPostWarehouseRepository
	) {}

	syncWithProgress(): Observable<MessageEvent> {
		const subject = new Subject<MessageEvent>()

		this.runSync(subject)
			.then(result => {
				subject.next({ data: { type: 'done', ...result } })
				subject.complete()
			})
			.catch(err => {
				subject.next({ data: { type: 'error', message: err.message } })
				subject.complete()
			})

		return subject.asObservable()
	}

	private async runSync(
		subject: Subject<MessageEvent>
	): Promise<{ cities: number; warehouses: number }> {
		this.logger.log('Starting Nova Post sync — clearing existing data')
		await Promise.all([this.cityRepo.clearAll(), this.warehouseRepo.clearAll()])
		const cities = await this.syncCities(synced =>
			subject.next({
				data: { type: 'progress', entity: 'cities', synced }
			})
		)
		const warehouses = await this.syncWarehouses(synced =>
			subject.next({
				data: { type: 'progress', entity: 'warehouses', synced }
			})
		)
		this.logger.log(`Sync complete — cities: ${cities}, warehouses: ${warehouses}`)
		return { cities, warehouses }
	}

	private async syncCities(onProgress?: (synced: number) => void): Promise<number> {
		let page = 1
		let total = 0

		while (true) {
			const { success, data, errors } = await this.fetchWithRetry<NpCity>({
				modelName: 'Address',
				calledMethod: 'getCities',
				page,
				limit: CITIES_PAGE_SIZE
			})

			if (!success || !data?.length) {
				if (!success) this.logger.warn(`Cities page ${page} failed: ${errors?.join(', ')}`)
				break
			}

			const docs: Partial<NovaPostCity>[] = data.map(c => ({
				ref: c.Ref,
				name: c.Description,
				settlementType: c.SettlementType,
				area: c.AreaDescription
			}))

			const count = await this.cityRepo.bulkUpsert(docs)
			total += count
			this.logger.debug(`Cities page ${page}: ${data.length} fetched, ${count} upserted`)
			onProgress?.(total)

			if (data.length < CITIES_PAGE_SIZE) break
			page++
			await sleep(REQUEST_DELAY_MS)
		}

		return total
	}

	private async syncWarehouses(onProgress?: (synced: number) => void): Promise<number> {
		let page = 1
		let total = 0

		while (true) {
			const { success, data, errors } = await this.fetchWithRetry<NpWarehouse>({
				modelName: 'AddressGeneral',
				calledMethod: 'getWarehouses',
				page,
				limit: WAREHOUSES_PAGE_SIZE
			})

			if (!success || !data?.length) {
				if (!success)
					this.logger.warn(`Warehouses page ${page} failed: ${errors?.join(', ')}`)
				break
			}

			const docs: Partial<NovaPostWarehouse>[] = data.map(w => ({
				ref: w.Ref,
				description: w.Description,
				shortAddress: w.ShortAddress,
				number: Number(w.Number) || 0,
				cityRef: w.CityRef,
				cityName: w.CityDescription,
				maxWeightAllowed: Number(w.TotalMaxWeightAllowed) || 0,
				typeOfWarehouse: w.TypeOfWarehouse,
				postalCode: w.PostalCodeUA
			}))

			const count = await this.warehouseRepo.bulkUpsert(docs)
			total += count
			this.logger.debug(`Warehouses page ${page}: ${data.length} fetched, ${count} upserted`)
			onProgress?.(total)

			if (data.length < WAREHOUSES_PAGE_SIZE) break
			page++
			await sleep(REQUEST_DELAY_MS)
		}

		return total
	}

	private async fetchWithRetry<T>(params: {
		modelName: string
		calledMethod: string
		page: number
		limit: number
	}): Promise<NpApiResponse<T>> {
		const { modelName, calledMethod, page, limit } = params

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			const response = await axios.post<NpApiResponse<T>>(NP_API_URL, {
				apiKey: ENV.NOVA_POS_API_KEY,
				modelName,
				calledMethod,
				methodProperties: { Page: String(page), Limit: String(limit) }
			})

			const result = response.data

			const isRateLimited =
				!result.success &&
				result.errors?.some(
					e => e.toLowerCase().includes('too many') || e.toLowerCase().includes('to many')
				)

			if (isRateLimited && attempt < MAX_RETRIES) {
				this.logger.warn(
					`Rate limited on ${calledMethod} page ${page}, retry ${attempt}/${MAX_RETRIES}`
				)
				await sleep(RETRY_DELAY_MS * attempt)
				continue
			}

			return result
		}

		return { success: false, data: [], errors: ['Max retries exceeded'] }
	}
}
