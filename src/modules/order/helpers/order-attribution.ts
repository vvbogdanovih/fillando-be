import type { AdsConsent, OrderAttribution } from 'src/database/mongoose/schemas/order.schema'

/** What the checkout sends about the visit (`CreateOrderAttributionDto`). */
export type AttributionInput = {
	consent: AdsConsent
	gclid?: string
	gbraid?: string
	wbraid?: string
}

/** What the server itself saw of the request that placed the order. */
export type OrderClient = { ip?: string; userAgent?: string }

const USER_AGENT_MAX_LENGTH = 512

/**
 * The attribution an order is stored with (owner, 2026-11-16).
 *
 * One rule: without the buyer's consent nothing but the answer itself is kept — no click id, no
 * address, no browser — so the order holds nothing that could be sent to Google Ads later. A
 * client that sends no `attribution` at all (an older storefront build) has not asked the buyer,
 * which is `unknown`.
 */
export function buildOrderAttribution(
	input: AttributionInput | undefined,
	client: OrderClient = {}
): OrderAttribution {
	const consent = input?.consent ?? 'unknown'
	if (consent !== 'granted') {
		return {
			consent,
			gclid: null,
			gbraid: null,
			wbraid: null,
			ip_address: null,
			user_agent: null
		}
	}
	return {
		consent,
		gclid: input?.gclid ?? null,
		gbraid: input?.gbraid ?? null,
		wbraid: input?.wbraid ?? null,
		ip_address: client.ip ?? null,
		user_agent: client.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) || null
	}
}
