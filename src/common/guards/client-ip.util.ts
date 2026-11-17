import { BlockList, isIP } from 'node:net'
import type { Request } from 'express'

/**
 * Cloudflare's edge ranges, as published at https://www.cloudflare.com/ips-v4 and /ips-v6
 * (read 02.11.2026). They change rarely; a range missing here is safe — a visitor arriving
 * through it is counted by the edge address, as before P11 — so update the list when Cloudflare
 * announces a change rather than fetching it at runtime.
 */
export const CLOUDFLARE_RANGES = [
	'173.245.48.0/20',
	'103.21.244.0/22',
	'103.22.200.0/22',
	'103.31.4.0/22',
	'141.101.64.0/18',
	'108.162.192.0/18',
	'190.93.240.0/20',
	'188.114.96.0/20',
	'197.234.240.0/22',
	'198.41.128.0/17',
	'162.158.0.0/15',
	'104.16.0.0/13',
	'104.24.0.0/14',
	'172.64.0.0/13',
	'131.0.72.0/22',
	'2400:cb00::/32',
	'2606:4700::/32',
	'2803:f800::/32',
	'2405:b500::/32',
	'2405:8100::/32',
	'2a06:98c0::/29',
	'2c0f:f248::/32'
] as const

const familyOf = (address: string) => (isIP(address) === 6 ? 'ipv6' : 'ipv4')
const cloudflare = new BlockList()
for (const range of CLOUDFLARE_RANGES) {
	const [network, bits] = range.split('/')
	cloudflare.addSubnet(network, Number(bits), familyOf(network))
}

/** Whether `address` is a Cloudflare edge (IPv4-mapped IPv6 included). */
export function fromCloudflare(address: string): boolean {
	return isIP(address) !== 0 && cloudflare.check(address, familyOf(address))
}

/**
 * The visitor behind a request (P11, owner decision 02.11.2026): what rate limits are counted
 * against and what a refresh token records.
 *
 * `req.ip` is the address the proxy in front of the app saw (`main.ts` trusts one hop). Behind
 * Cloudflare that is an edge node shared by everyone it serves, and the visitor is in
 * `CF-Connecting-IP` — which Cloudflare overwrites, so it is believed **only** when `req.ip` is a
 * Cloudflare edge. A request that reaches the origin around Cloudflare (Railway's own
 * `*.up.railway.app` address) then has its own address as `req.ip` and cannot choose its key by
 * sending the header — provided the proxy in front appends the address it saw to
 * `X-Forwarded-For`, which the one-hop trust in `main.ts` assumes; Railway does not document it,
 * so it is a release check (runbook §3.10). The head of `X-Forwarded-For` is never read: the
 * client writes it.
 */
export function clientIp(req: Request): string | undefined {
	const peer = req.ip ?? req.socket?.remoteAddress
	const header = req.headers?.['cf-connecting-ip']
	const visitor = (Array.isArray(header) ? header[0] : header)?.trim()
	if (peer && visitor && isIP(visitor) && fromCloudflare(peer)) return visitor
	return peer
}
