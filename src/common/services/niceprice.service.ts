import { Injectable, Logger } from '@nestjs/common'

export interface NicePriceStock {
	vendor_product_sku: string
	stock: number
}

@Injectable()
export class NicePriceService {
	private readonly logger = new Logger(NicePriceService.name)

	async getStock(vendorProductSku: string): Promise<number> {
		try {
			// TODO: replace with real NicePrice API call
			this.logger.log(`Fetching stock for sku: ${vendorProductSku}`)
			return 0
		} catch (err) {
			this.logger.error(`Failed to fetch stock for sku ${vendorProductSku}`, err)
			return 0
		}
	}
}
