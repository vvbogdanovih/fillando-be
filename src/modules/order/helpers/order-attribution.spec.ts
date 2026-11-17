import { buildOrderAttribution } from './order-attribution'

const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130' }
const NOTHING = { gclid: null, gbraid: null, wbraid: null, ip_address: null, user_agent: null }

describe('buildOrderAttribution', () => {
	it('keeps click ids, address and browser once the buyer consented', () => {
		expect(buildOrderAttribution({ consent: 'granted', gclid: 'Cj0K_abc-1' }, CLIENT)).toEqual({
			consent: 'granted',
			gclid: 'Cj0K_abc-1',
			gbraid: null,
			wbraid: null,
			ip_address: CLIENT.ip,
			user_agent: CLIENT.userAgent
		})
	})

	it.each(['denied', 'unknown'] as const)(
		'keeps only the answer under «%s», whatever the client sent',
		consent => {
			expect(
				buildOrderAttribution({ consent, gclid: 'a', gbraid: 'b', wbraid: 'c' }, CLIENT)
			).toEqual({ consent, ...NOTHING })
		}
	)

	it('reads a client that sends no attribution as «unknown»', () => {
		expect(buildOrderAttribution(undefined, CLIENT)).toEqual({ consent: 'unknown', ...NOTHING })
	})

	it('stores a consenting order without a click id, and one whose request shows no client', () => {
		expect(buildOrderAttribution({ consent: 'granted' })).toEqual({
			consent: 'granted',
			...NOTHING
		})
	})

	it('cuts an oversized User-Agent rather than storing whatever arrives', () => {
		const stored = buildOrderAttribution(
			{ consent: 'granted' },
			{ userAgent: 'x'.repeat(5000) }
		)
		expect(stored.user_agent).toHaveLength(512)
	})
})
