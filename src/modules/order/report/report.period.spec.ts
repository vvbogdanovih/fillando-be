import { storeDayEnd, storeDayKey, storeDayStart } from './report.period'

describe('storeDayStart / storeDayEnd', () => {
	it('opens a summer day at 21:00 UTC the evening before (EEST, UTC+3)', () => {
		expect(storeDayStart('2026-09-01').toISOString()).toBe('2026-08-31T21:00:00.000Z')
	})

	it('closes a summer day at 20:59:59.999 UTC on the same date', () => {
		expect(storeDayEnd('2026-09-30').toISOString()).toBe('2026-09-30T20:59:59.999Z')
	})

	it('opens a winter day at 22:00 UTC the evening before (EET, UTC+2)', () => {
		expect(storeDayStart('2026-01-15').toISOString()).toBe('2026-01-14T22:00:00.000Z')
	})

	it('resolves the day the clocks go back, where the naive offset is the wrong one', () => {
		// DST ends 2026-10-25 04:00 Kyiv; the day still opens at UTC+3.
		expect(storeDayStart('2026-10-25').toISOString()).toBe('2026-10-24T21:00:00.000Z')
		expect(storeDayEnd('2026-10-25').toISOString()).toBe('2026-10-25T21:59:59.999Z')
	})

	it('keeps an order placed just after Kyiv midnight inside its own day', () => {
		const placed = new Date('2026-08-31T21:30:00.000Z') // 00:30 on 1 September in Kyiv

		expect(placed >= storeDayStart('2026-09-01')).toBe(true)
		expect(placed <= storeDayEnd('2026-09-01')).toBe(true)
		expect(placed > storeDayEnd('2026-08-31')).toBe(true)
	})
})

describe('storeDayKey', () => {
	it('groups an instant by the Kyiv day, not the UTC one', () => {
		expect(storeDayKey(new Date('2026-08-31T21:30:00.000Z'))).toBe('2026-09-01')
		expect(storeDayKey(new Date('2026-09-01T20:59:00.000Z'))).toBe('2026-09-01')
	})
})
