import { Controller, Get, Post, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
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
	 * Public, like sitemap.xml. A 503 before the first generation is deliberate: a fetch
	 * failure makes Merchant retry, an empty channel makes it delist everything.
	 */
	@Get(ENDPOINTS.FEEDS.GOOGLE_SHOPPING_XML)
	@ApiOperation(API_OPERATION.FEEDS.GOOGLE_SHOPPING_XML)
	getGoogleShoppingFeed(@Res() res: Response): void {
		const cached = this.feedService.getXml()
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
			'Cache-Control': 'public, max-age=300'
		})
		res.end(cached.xml)
	}

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
