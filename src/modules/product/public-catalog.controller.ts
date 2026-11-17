import {
	CatalogCategoryCountsDto,
	CatalogStripResponseDto,
	PublicCatalogResponseDto
} from './dto/public-catalog.dto'
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import {
	ApiBadRequestResponse,
	ApiConflictResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiQuery,
	ApiServiceUnavailableResponse,
	ApiTags
} from '@nestjs/swagger'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { API_OPERATION, ENDPOINTS, CATALOG_UNAVAILABLE } from 'src/common/constants'
import {
	CatalogAdaptedRead,
	LegacyCatalogController
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { PublicCatalogService } from './public-catalog.service'
import { PublicProductService } from './public-product.service'
import { SearchProductsDto } from './dto/search-products.dto'
import { GetPriceSheetQueryDto } from './dto/get-price-sheet-query.dto'
import { PriceSheetResponseDto } from './dto/price-sheet-response.dto'

/**
 * Storefront reads that understand the category tree (TD-0013). Each one resolves visibility
 * through the public category projection — active product categories whose ancestors are all
 * active — so they may run while v2/draft categories exist, unlike the remaining legacy reads.
 * Registered before `ProductController`, whose `/:id` would otherwise shadow nothing here but
 * must never be reached by these paths.
 */
@LegacyCatalogController()
@Controller(ENDPOINTS.PRODUCTS.BASE)
@ApiTags(ENDPOINTS.PRODUCTS.BASE)
export class PublicCatalogController {
	constructor(
		private readonly catalog: PublicCatalogService,
		private readonly products: PublicProductService
	) {}

	// Three `$facet` aggregations per request — the most expensive public read, and the storefront
	// calls it on every filter click, so it is throttled generously rather than left open (§4a).
	//
	// `Record<string, string>` rather than a DTO on purpose: besides the reserved parameters the
	// catalogue accepts arbitrary attribute filters (`?polymer=PLA`), and the global
	// `ValidationPipe` runs with `whitelist: true` — a DTO class would strip every key it does not
	// declare and the filters would silently stop working. The reserved parameters are parsed
	// defensively in the service instead.
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.CATALOG)
	@CatalogAdaptedRead()
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 120, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.PRODUCTS.CATALOG)
	@ApiNotFoundResponse({ description: 'Category missing, not a product category or hidden' })
	@ApiConflictResponse({
		description: 'ATTRIBUTE_CONTRACT_UPGRADE_REQUIRED — a v2 category is read via /catalog/v2'
	})
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	getCatalog(@Query() query: Record<string, string>) {
		return this.catalog.legacy(query)
	}

	// Before nothing that could swallow it: a fixed path under /catalog/v2.
	@Get(ENDPOINTS.PRODUCTS.CATALOG_V2_CATEGORY_COUNTS)
	@CatalogAdaptedRead()
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 120, ttl: 60000 } })
	@ApiOperation(API_OPERATION.PRODUCTS.CATALOG_V2_CATEGORY_COUNTS)
	@ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 20000 })
	@ApiQuery({ name: 'cursor', required: false, type: String })
	@ApiOkResponse({ type: CatalogCategoryCountsDto })
	@ApiBadRequestResponse({ description: 'Invalid limit or cursor' })
	@ApiConflictResponse({ description: 'CATEGORY_COUNTS_CHANGED — restart pagination' })
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	categoryCounts(@Query() query: Record<string, unknown>) {
		return this.catalog.categoryCounts(query)
	}

	// One card per product for the storefront's strips: the listing's scope, filters and guards.
	@Get(ENDPOINTS.PRODUCTS.CATALOG_V2_STRIP)
	@CatalogAdaptedRead()
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 120, ttl: 60000 } })
	@ApiOperation(API_OPERATION.PRODUCTS.CATALOG_V2_STRIP)
	@ApiQuery({ name: 'category_id', required: false, type: String })
	@ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 24 })
	@ApiQuery({
		name: 'filters',
		required: false,
		type: String,
		description: 'The strict JSON of GET /products/catalog/v2, at most 16 KiB'
	})
	@ApiOkResponse({ type: CatalogStripResponseDto })
	@ApiBadRequestResponse({ description: 'Invalid filters, query or scope' })
	@ApiNotFoundResponse({ description: 'Category missing or hidden by ancestor' })
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	strip(@Query() query: Record<string, unknown>) {
		return this.catalog.strip(query)
	}

	@Get(ENDPOINTS.PRODUCTS.CATALOG_V2)
	@CatalogAdaptedRead()
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 120, ttl: 60000 } })
	@ApiOperation(API_OPERATION.PRODUCTS.CATALOG_V2)
	@ApiQuery({ name: 'category_id', required: false, type: String })
	@ApiQuery({ name: 'page', required: false, type: Number, minimum: 1, maximum: 1000000 })
	@ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
	@ApiQuery({ name: 'sort', required: false, enum: ['newest', 'price_asc', 'price_desc'] })
	@ApiQuery({
		name: 'filters',
		required: false,
		type: String,
		description:
			'Strict JSON, at most 16 KiB: attributes, category_ids (≤100), brand_ids (≤100), price {min,max}, in_stock, product_ids (≤24 — a curated storefront collection: SKUs of these products only), on_sale (true only — SKUs on a live promotion, for the catalogue hub «Акції» strip). color_families (≤100, dictionary families) only in a product category with a colour-semantic axis. Unknown keys, repeated scalar parameters, invalid types and filters outside scope are rejected.'
	})
	@ApiOkResponse({ type: PublicCatalogResponseDto })
	@ApiBadRequestResponse({ description: 'Invalid filters, query or scope' })
	@ApiNotFoundResponse({ description: 'Category missing or hidden by ancestor' })
	@ApiServiceUnavailableResponse({
		description:
			'Catalog maintenance, changed revision/epoch, corrupt category data or missing control; Retry-After: 5, no-store'
	})
	read(@Query() query: Record<string, unknown>) {
		return this.catalog.read(query)
	}

	@Get(ENDPOINTS.PRODUCTS.PRICE_SHEET)
	@CatalogAdaptedRead()
	@UseGuards(ThrottlerGuard)
	@Throttle({ default: { limit: 20, ttl: 60_000 } })
	@ApiOperation(API_OPERATION.PRODUCTS.PRICE_SHEET)
	@ApiOkResponse({ type: PriceSheetResponseDto })
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	getPriceSheet(@Query() query: GetPriceSheetQueryDto) {
		return this.catalog.priceSheet(query)
	}

	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.SEARCH)
	@CatalogAdaptedRead()
	@ApiOperation(API_OPERATION.PRODUCTS.SEARCH)
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	search(@Query() dto: SearchProductsDto) {
		return this.catalog.search(dto)
	}

	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.BY_SLUG)
	@CatalogAdaptedRead()
	@ApiOperation(API_OPERATION.PRODUCTS.BY_SLUG)
	@ApiNotFoundResponse({ description: 'Unknown or draft SKU, or its category is not public' })
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	getVariantBySlug(@Param('slug') slug: string) {
		return this.products.bySlug(slug)
	}
}
