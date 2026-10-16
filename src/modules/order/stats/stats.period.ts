import { BadRequestException } from '@nestjs/common'
import { storeDayKey } from '../report/report.period'

/**
 * Calendar arithmetic for the dashboard period, on `YYYY-MM-DD` strings only.
 *
 * Every function here works in `Date.UTC` and never builds a Kyiv instant, so neither DST nor
 * the server's own zone can move a day: adding one day to `2026-10-24` is `2026-10-25` even
 * though that Kyiv day has 25 hours. Instants are the business of `report.period.ts`.
 */
export const DEFAULT_STATS_DAYS = 30
export const MAX_STATS_DAYS = 366
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const MS_PER_DAY = 86_400_000

export interface StatsPeriodWindow {
	dateFrom: string
	dateTo: string
	/** Inclusive day count. */
	days: number
}

export interface StatsPeriod extends StatsPeriodWindow {
	/** The window of the same length that ends the day before `dateFrom`. */
	previous: StatsPeriodWindow
}

function dayToUtc(day: string): number {
	const [year, month, date] = day.split('-').map(Number)
	return Date.UTC(year, month - 1, date)
}

function utcToDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10)
}

/** True for a `YYYY-MM-DD` that names a real day — `2026-02-30` fails the round trip. */
export function isCalendarDay(value: string): boolean {
	return DAY_PATTERN.test(value) && utcToDay(dayToUtc(value)) === value
}

export function addDays(day: string, delta: number): string {
	return utcToDay(dayToUtc(day) + delta * MS_PER_DAY)
}

/** Inclusive: `daysBetween('2026-09-01', '2026-09-01')` is 1. */
export function daysBetween(from: string, to: string): number {
	return Math.round((dayToUtc(to) - dayToUtc(from)) / MS_PER_DAY) + 1
}

export function enumerateDays(from: string, to: string): string[] {
	const days: string[] = []
	for (let ms = dayToUtc(from); ms <= dayToUtc(to); ms += MS_PER_DAY) days.push(utcToDay(ms))
	return days
}

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export function isoWeekday(day: string): number {
	const utcDay = new Date(dayToUtc(day)).getUTCDay()
	return utcDay === 0 ? 7 : utcDay
}

/**
 * Resolves the query to Kyiv calendar days. Both omitted: the last `DEFAULT_STATS_DAYS` days
 * ending today (today being the Kyiv day of `now`, not the server's). One given: a default-length
 * window anchored on it. A reversed or over-long range is the caller's mistake, answered 400.
 */
export function resolveStatsPeriod(
	query: { date_from?: string; date_to?: string },
	now: Date = new Date()
): StatsPeriod {
	for (const value of [query.date_from, query.date_to]) {
		if (value !== undefined && !isCalendarDay(value)) {
			throw new BadRequestException(`Невірна дата: ${value}`)
		}
	}

	const span = DEFAULT_STATS_DAYS - 1
	let dateFrom: string
	let dateTo: string

	if (query.date_from && query.date_to) {
		dateFrom = query.date_from
		dateTo = query.date_to
	} else if (query.date_from) {
		dateFrom = query.date_from
		dateTo = addDays(dateFrom, span)
	} else {
		dateTo = query.date_to ?? storeDayKey(now)
		dateFrom = addDays(dateTo, -span)
	}

	if (dateFrom > dateTo) {
		throw new BadRequestException('Дата «від» пізніша за дату «до»')
	}

	const days = daysBetween(dateFrom, dateTo)
	if (days > MAX_STATS_DAYS) {
		throw new BadRequestException(`Період не може перевищувати ${MAX_STATS_DAYS} днів`)
	}

	const previousTo = addDays(dateFrom, -1)
	const previousFrom = addDays(previousTo, -(days - 1))

	return {
		dateFrom,
		dateTo,
		days,
		previous: { dateFrom: previousFrom, dateTo: previousTo, days }
	}
}
