import { FeedRefreshSignal } from './feed-refresh.signal'

describe('FeedRefreshSignal', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())

	it('is a no-op with nobody subscribed', () => {
		const signal = new FeedRefreshSignal()
		expect(() => signal.request('promo')).not.toThrow()
		jest.runAllTimers()
	})

	it('collapses a burst of requests into one call carrying every trigger', () => {
		const signal = new FeedRefreshSignal()
		const listener = jest.fn()
		signal.subscribe(listener)

		signal.request('variant promotion')
		signal.request('variant promotion')
		signal.request('product promotion')
		expect(listener).not.toHaveBeenCalled()

		jest.advanceTimersByTime(5000)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith('variant promotion, product promotion')
	})

	it('opens a new window after the first flush', () => {
		const signal = new FeedRefreshSignal()
		const listener = jest.fn()
		signal.subscribe(listener)

		signal.request('a')
		jest.advanceTimersByTime(5000)
		signal.request('b')
		jest.advanceTimersByTime(5000)

		expect(listener.mock.calls).toEqual([['a'], ['b']])
	})

	it('hands the signal to the last subscriber', () => {
		const signal = new FeedRefreshSignal()
		const first = jest.fn()
		const second = jest.fn()
		signal.subscribe(first)
		signal.subscribe(second)
		signal.request('x')
		jest.advanceTimersByTime(5000)
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledWith('x')
	})
})
