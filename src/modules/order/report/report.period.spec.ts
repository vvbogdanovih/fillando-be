import { storeDayEnd, storeDayKey, storeDayStart, storeHour } from './report.period'

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

describe('storeHour', () => {
	it('reads the Kyiv wall-clock hour, summer and winter', () => {
		expect(storeHour(new Date('2026-08-31T21:30:00.000Z'))).toBe(0)
		expect(storeHour(new Date('2026-09-01T20:59:00.000Z'))).toBe(23)
		expect(storeHour(new Date('2026-01-15T22:30:00.000Z'))).toBe(0)
	})

	it('never answers 24 at exact midnight', () => {
		expect(storeHour(new Date('2026-06-30T21:00:00.000Z'))).toBe(0)
	})

	it('reads the repeated hour of the fall-back night as 3 twice', () => {
		// 04:00 EEST becomes 03:00 EET on 2026-10-25: 00:30Z and 01:30Z both show 03:xx.
		expect(storeHour(new Date('2026-10-25T00:30:00.000Z'))).toBe(3)
		expect(storeHour(new Date('2026-10-25T01:30:00.000Z'))).toBe(3)
		expect(storeHour(new Date('2026-10-25T21:30:00.000Z'))).toBe(23)
	})

	it('skips the hour that does not exist on the spring-forward night', () => {
		// 03:00 EET becomes 04:00 EEST on 2026-03-29: 02:xx exists, 03:xx does not.
		expect(storeHour(new Date('2026-03-29T00:30:00.000Z'))).toBe(2)
		expect(storeHour(new Date('2026-03-29T01:30:00.000Z'))).toBe(4)
	})
})
