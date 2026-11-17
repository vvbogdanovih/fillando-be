import { Controller, Get, Post, Res, UseGuards, ServiceUnavailableException } from '@nestjs/common'
import {
	ApiCreatedResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
	ApiServiceUnavailableResponse
} from '@nestjs/swagger'
import type { Response } from 'express'
import { pipeline } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'
import { API_OPERATION } from 'src/common/constants/docs/api-operation.constant'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { FeedService } from './feed.service'
import type { FeedGenerationSummary, FeedStatus } from './feed.types'

/** How long Merchant should wait before retrying while the first generation is running. */
const RETRY_AFTER_SECONDS = 60

@ApiTags(ENDPOINTS.FEEDS.BASE)
@Controller(ENDPOINTS.FEEDS.BASE)
export class FeedController {
	constructor(
		@InjectPinoLogger(FeedController.name) private readonly logger: PinoLogger,
		private readonly feedService: FeedService
	) {}

	/**
	 * Public, like sitemap.xml. A 503 is deliberate wherever there is no XML to serve: a fetch
	 * failure makes Merchant retry, an empty channel makes it delist everything. That covers
	 * both the window before the first generation and a run that produced zero items —
	 * `FeedService` refuses to cache such a run, so the cached XML always holds items.
	 */
	@ApiServiceUnavailableResponse({
		description:
			'Feed unavailable, stale generation stamp or catalog maintenance. Retry-After and no-store are returned.'
	})
	@ApiOkResponse()
	@Get(ENDPOINTS.FEEDS.GOOGLE_SHOPPING_XML)
	@ApiOperation(API_OPERATION.FEEDS.GOOGLE_SHOPPING_XML)
	async getGoogleShoppingFeed(@Res() res: Response): Promise<void> {
		let cached: Awaited<ReturnType<FeedService['getVerifiedXml']>>
		try {
			cached = await this.feedService.getVerifiedXml()
		} catch (error) {
			if (error instanceof ServiceUnavailableException)
				res.set({ 'Retry-After': '5', 'Cache-Control': 'no-store' })
			throw error
		}
		if (!cached) {
			res.status(503)
				.set({ 'Retry-After': String(RETRY_AFTER_SECONDS), 'Cache-Control': 'no-store' })
				.json({
					statusCode: 503,
					message: 'Feed is being generated — retry shortly',
					retry_after: RETRY_AFTER_SECONDS
				})
			return
		}
		res.set({
			'Content-Type': 'application/xml; charset=utf-8',
			'Last-Modified': cached.generatedAt.toUTCString(),
			'Cache-Control': 'public, max-age=300',
			// What `res.end(xml)` used to set implicitly: the body is streamed now, not chunked.
			'Content-Length': String(cached.bytes)
		})
		// The feed is kept compressed (Plan-0010 D06): the same bytes, inflated as they are sent,
		// so a fetch never materialises the whole document.
		const inflate = createGunzip()
		pipeline(inflate, res, error => {
			if (error)
				this.logger.warn(`Google Shopping feed response ended early: ${error.message}`)
		})
		inflate.end(cached.gzip)
	}

	@ApiServiceUnavailableResponse({
		description:
			'Catalog maintenance, changed revision/epoch or incompatible catalog contract. Previous XML is retained.'
	})
	@ApiCreatedResponse()
	@Post(ENDPOINTS.FEEDS.GOOGLE_SHOPPING_REGENERATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.FEEDS.GOOGLE_SHOPPING_REGENERATE)
	regenerate(): Promise<FeedGenerationSummary> {
		this.logger.info('Manual Google Shopping feed regeneration triggered')
		return this.feedService.generate()
	}

	@Get(ENDPOINTS.FEEDS.GOOGLE_SHOPPING_STATUS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.FEEDS.GOOGLE_SHOPPING_STATUS)
	status(): FeedStatus {
		return this.feedService.getStatus()
	}
}
