import type { Connection } from 'mongoose'
import { hashFingerprint as categoryFingerprint } from './category-fingerprint'

/** A connection whose fingerprint passes resolve when the test says so. */
function connection() {
	const passes: ((value: { count: number; hash: number }[]) => void)[] = []
	const aggregate = jest.fn(() => ({
		toArray: () => new Promise<{ count: number; hash: number }[]>(done => passes.push(done))
	}))
	return {
		connection: { collection: () => ({ aggregate }) } as unknown as Connection,
		aggregate,
		passes
	}
}

describe('categoryFingerprint', () => {
	it('shares a pass only with callers that arrived before it started', async () => {
		const { connection: db, aggregate, passes } = connection()
		const first = categoryFingerprint(db)
		// Arrives while the first pass runs: may not use it (it may have read before a write).
		const second = categoryFingerprint(db)
		const third = categoryFingerprint(db)
		expect(aggregate).toHaveBeenCalledTimes(1)
		passes[0]([{ count: 1, hash: 1 }])
		expect(await first).toBe('1:1')
		await new Promise(resolve => setImmediate(resolve))
		// One next pass for both waiting callers.
		expect(aggregate).toHaveBeenCalledTimes(2)
		passes[1]([{ count: 2, hash: 2 }])
		expect(await second).toBe('2:2')
		expect(await third).toBe('2:2')
		// Idle again: a new caller starts its own pass.
		const fourth = categoryFingerprint(db)
		expect(aggregate).toHaveBeenCalledTimes(3)
		passes[2]([{ count: 3, hash: 3 }])
		expect(await fourth).toBe('3:3')
	})
	it('starts the next pass even when the running one fails', async () => {
		const { connection: db, aggregate, passes } = connection()
		const failing = categoryFingerprint(db)
		const waiting = categoryFingerprint(db)
		passes[0](undefined as never)
		await expect(failing).rejects.toBeDefined()
		await new Promise(resolve => setImmediate(resolve))
		expect(aggregate).toHaveBeenCalledTimes(2)
		passes[1]([{ count: 4, hash: 4 }])
		expect(await waiting).toBe('4:4')
	})
})
