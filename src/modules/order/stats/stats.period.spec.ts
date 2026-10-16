import { BadRequestException } from '@nestjs/common'
import {
	addDays,
	daysBetween,
	enumerateDays,
	isCalendarDay,
	isoWeekday,
	MAX_STATS_DAYS,
	resolveStatsPeriod
} from './stats.period'

describe('calendar arithmetic on YYYY-MM-DD', () => {
	it('adds days across a month end, a year end and a leap day', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
	})

	it('crosses the DST switch as a whole day, not 23 or 25 hours', () => {
		expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
		expect(addDays('2026-10-26', -1)).toBe('2026-10-25')
		expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
	})

	it('counts days inclusively and enumerates them in order', () => {
		expect(daysBetween('2026-09-01', '2026-09-01')).toBe(1)
		expect(daysBetween('2026-09-01', '2026-09-30')).toBe(30)
		expect(enumerateDays('2026-09-01', '2026-09-03')).toEqual([
			'2026-09-01',
			'2026-09-02',
			'2026-09-03'
		])
		expect(enumerateDays('2026-09-01', '2026-09-01')).toEqual(['2026-09-01'])
	})

	it('numbers weekdays the ISO way, Monday 1 through Sunday 7', () => {
		expect(isoWeekday('2026-10-16')).toBe(5)
		expect(isoWeekday('2026-10-18')).toBe(7)
		expect(isoWeekday('2026-10-19')).toBe(1)
	})

	it('accepts only a day that exists', () => {
		expect(isCalendarDay('2026-02-28')).toBe(true)
		expect(isCalendarDay('2026-02-30')).toBe(false)
		expect(isCalendarDay('2026-13-01')).toBe(false)
		expect(isCalendarDay('2026-9-1')).toBe(false)
		expect(isCalendarDay('2026-09-01T00:00:00Z')).toBe(false)
	})
})

describe('resolveStatsPeriod', () => {
	it('defaults to the last 30 days ending on the Kyiv day of now, not the UTC one', () => {
		// 21:30 UTC on 31 August is already 00:30 on 1 September in Kyiv.
		const period = resolveStatsPeriod({}, new Date('2026-08-31T21:30:00.000Z'))

		expect(period).toMatchObject({ dateFrom: '2026-08-03', dateTo: '2026-09-01', days: 30 })
	})

	it('anchors a default-length window on whichever end is given', () => {
		expect(resolveStatsPeriod({ date_to: '2026-09-30' })).toMatchObject({
			dateFrom: '2026-09-01',
			dateTo: '2026-09-30',
			days: 30
		})
		expect(resolveStatsPeriod({ date_from: '2026-09-01' })).toMatchObject({
			dateFrom: '2026-09-01',
			dateTo: '2026-09-30',
			days: 30
		})
	})

	it('takes both ends as given', () => {
		expect(
			resolveStatsPeriod({ date_from: '2026-09-01', date_to: '2026-09-14' })
		).toMatchObject({
			dateFrom: '2026-09-01',
			dateTo: '2026-09-14',
			days: 14
		})
	})

	it('lays the previous period of the same length right before the current one', () => {
		const month = resolveStatsPeriod({ date_from: '2026-09-01', date_to: '2026-09-30' })
		expect(month.previous).toEqual({ dateFrom: '2026-08-02', dateTo: '2026-08-31', days: 30 })

		const day = resolveStatsPeriod({ date_from: '2026-09-01', date_to: '2026-09-01' })
		expect(day.previous).toEqual({ dateFrom: '2026-08-31', dateTo: '2026-08-31', days: 1 })

		// Both windows straddle a DST switch; day counts do not notice.
		const dst = resolveStatsPeriod({ date_from: '2026-10-20', date_to: '2026-10-30' })
		expect(dst.previous).toEqual({ dateFrom: '2026-10-09', dateTo: '2026-10-19', days: 11 })
	})

	it('refuses a reversed range', () => {
		expect(() =>
			resolveStatsPeriod({ date_from: '2026-09-30', date_to: '2026-09-01' })
		).toThrow(BadRequestException)
	})

	it('caps the range at a year and a day', () => {
		expect(resolveStatsPeriod({ date_from: '2025-10-16', date_to: '2026-10-16' }).days).toBe(
			MAX_STATS_DAYS
		)
		expect(() =>
			resolveStatsPeriod({ date_from: '2025-10-15', date_to: '2026-10-16' })
		).toThrow(BadRequestException)
	})

	it('refuses a day that does not exist even when the shape is right', () => {
		expect(() => resolveStatsPeriod({ date_from: '2026-02-30' })).toThrow(BadRequestException)
	})
})
