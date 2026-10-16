import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { GetOrderStatsQueryDto } from './get-order-stats-query.dto'

const dto = (query: Record<string, unknown>) => plainToInstance(GetOrderStatsQueryDto, query)

describe('GetOrderStatsQueryDto', () => {
	it('accepts no dates, one date and both', async () => {
		expect(await validate(dto({}))).toEqual([])
		expect(await validate(dto({ date_from: '2026-09-01' }))).toEqual([])
		expect(await validate(dto({ date_to: '2026-09-30' }))).toEqual([])
		expect(await validate(dto({ date_from: '2026-09-01', date_to: '2026-09-30' }))).toEqual([])
	})

	it.each([
		{ value: '2026-9-1', why: 'unpadded' },
		{
			value: '2026-09-01T00:00:00Z',
			why: 'a datetime — the report DTO tolerates it, this one does not'
		},
		{ value: '01.09.2026', why: 'the Ukrainian notation' },
		{ value: '2026-13-01', why: 'a month that does not exist' },
		{ value: '2026-02-30', why: 'a day that does not exist' },
		{ value: 'abc', why: 'not a date at all' },
		{ value: 20260901, why: 'a number' }
	])('rejects $value ($why)', async ({ value }) => {
		expect(await validate(dto({ date_from: value }))).not.toHaveLength(0)
		expect(await validate(dto({ date_to: value }))).not.toHaveLength(0)
	})
})
