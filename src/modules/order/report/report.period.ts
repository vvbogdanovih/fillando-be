/**
 * Calendar days for the sales report, resolved in the store's own zone.
 *
 * `new Date('2026-09-01')` is UTC midnight — 03:00 in Kyiv under EEST — so a range built that way
 * silently drops the first three hours of the opening day and borrows three hours of the day after
 * the closing one. Finance reconciles this report against bank statements kept in Kyiv days, so
 * both boundaries and the per-day grouping are resolved in `Europe/Kyiv`, never as server-local
 * instants. Same class of bug as the Prom discount window (see `prom-pricing.ts`).
 */
export const STORE_TIME_ZONE = 'Europe/Kyiv'

const wallClockParts = new Intl.DateTimeFormat('en-CA', {
	timeZone: STORE_TIME_ZONE,
	hour12: false,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
})

const dayFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: STORE_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
})

/** Minutes the store's zone runs ahead of UTC at a given instant: +180 in summer, +120 in winter. */
function zoneOffsetMinutes(at: Date): number {
	const parts = wallClockParts.formatToParts(at)
	const part = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)

	const asIfUtc = Date.UTC(
		part('year'),
		part('month') - 1,
		part('day'),
		part('hour') % 24,
		part('minute'),
		part('second')
	)

	// The formatter has no milliseconds, so compare against whole seconds.
	return (asIfUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000
}

/** A `YYYY-MM-DD` day plus a wall-clock time in the store's zone, as the UTC instant it names. */
function storeInstant(day: string, wallClock: string): Date {
	const naive = Date.parse(`${day}T${wallClock}Z`)

	// Two passes: the offset read at the naive instant can belong to the wrong side of a DST
	// switch, so it is re-read at the corrected one.
	const firstPass = naive - zoneOffsetMinutes(new Date(naive)) * 60_000

	return new Date(naive - zoneOffsetMinutes(new Date(firstPass)) * 60_000)
}

/** First instant of a `YYYY-MM-DD` day in the store's zone. */
export function storeDayStart(day: string): Date {
	return storeInstant(day, '00:00:00.000')
}

/** Last instant of a `YYYY-MM-DD` day in the store's zone. */
export function storeDayEnd(day: string): Date {
	return storeInstant(day, '23:59:59.999')
}

/** The calendar day an instant falls on in the store's zone, as a sortable `YYYY-MM-DD`. */
export function storeDayKey(at: Date): string {
	return dayFormat.format(new Date(at))
}
