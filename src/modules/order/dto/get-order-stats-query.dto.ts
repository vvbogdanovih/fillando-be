import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsDateString, IsOptional, Matches } from 'class-validator'
import { DAY_PATTERN } from '../stats/stats.period'

/**
 * `@IsDateString` alone accepts `2026-09-01T10:00:00Z`; the dashboard speaks in Kyiv calendar
 * days, so the pattern pins the shape and `strict` refuses a day that does not exist.
 */
export class GetOrderStatsQueryDto {
	@ApiPropertyOptional({
		example: '2026-09-01',
		description:
			'First day of the period, a Kyiv calendar day (`YYYY-MM-DD`). Omitted: 29 days before `date_to`.'
	})
	@IsOptional()
	@Matches(DAY_PATTERN, { message: 'date_from must be YYYY-MM-DD' })
	@IsDateString({ strict: true })
	date_from?: string

	@ApiPropertyOptional({
		example: '2026-09-30',
		description:
			'Last day of the period, a Kyiv calendar day (`YYYY-MM-DD`). Omitted: today in Kyiv, or 29 days after `date_from`.'
	})
	@IsOptional()
	@Matches(DAY_PATTERN, { message: 'date_to must be YYYY-MM-DD' })
	@IsDateString({ strict: true })
	date_to?: string
}
