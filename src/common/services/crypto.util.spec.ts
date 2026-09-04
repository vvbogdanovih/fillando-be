import { createHash, createHmac } from 'node:crypto'
import {
	liqpaySignature,
	orderAccessToken,
	verifyLiqpaySignature,
	verifyOrderAccessToken
} from './crypto.util'

const ORDER_NUMBER = 'FO-0000123'
const HEX_32 = /^[a-f0-9]{32}$/

describe('orderAccessToken', () => {
	it('is deterministic for the same order number', () => {
		expect(orderAccessToken(ORDER_NUMBER)).toBe(orderAccessToken(ORDER_NUMBER))
	})

	it('produces 32 lowercase hex characters', () => {
		const token = orderAccessToken(ORDER_NUMBER)
		expect(token).toHaveLength(32)
		expect(token).toMatch(HEX_32)
	})

	it('differs for different order numbers', () => {
		expect(orderAccessToken('FO-0000123')).not.toBe(orderAccessToken('FO-0000124'))
	})

	it('is hex(HMAC-SHA256(PAYMENT_ENCRYPTION_KEY, "order-lookup:" + orderNumber))[0:32]', () => {
		// Independent reference vector: pins the key AND the domain prefix, so a keyless or
		// prefix-less implementation (forgeable from the public order number) fails here.
		const expected = createHmac('sha256', process.env.PAYMENT_ENCRYPTION_KEY as string)
			.update(`order-lookup:${ORDER_NUMBER}`)
			.digest('hex')
			.slice(0, 32)
		expect(orderAccessToken(ORDER_NUMBER)).toBe(expected)
	})

	it('cannot be derived from the order number alone', () => {
		const keyless = createHash('sha256').update(ORDER_NUMBER).digest('hex').slice(0, 32)
		expect(orderAccessToken(ORDER_NUMBER)).not.toBe(keyless)
	})
})

describe('verifyOrderAccessToken', () => {
	const token = orderAccessToken(ORDER_NUMBER)

	it('accepts the token issued for the order', () => {
		expect(verifyOrderAccessToken(ORDER_NUMBER, token)).toBe(true)
	})

	it('rejects the right token paired with a different order number', () => {
		expect(verifyOrderAccessToken('FO-0000124', token)).toBe(false)
	})

	it('rejects a wrong token of the same length', () => {
		const flippedLast = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
		expect(flippedLast).toHaveLength(32)
		expect(verifyOrderAccessToken(ORDER_NUMBER, flippedLast)).toBe(false)
	})

	it('rejects a token of a different length', () => {
		expect(verifyOrderAccessToken(ORDER_NUMBER, token.slice(0, 31))).toBe(false)
		expect(verifyOrderAccessToken(ORDER_NUMBER, `${token}0`)).toBe(false)
	})

	it('rejects an empty string', () => {
		expect(verifyOrderAccessToken(ORDER_NUMBER, '')).toBe(false)
	})

	it('rejects the uppercase variant of the right token (byte-exact, no normalisation)', () => {
		const upper = token.toUpperCase()
		expect(upper).not.toBe(token)
		expect(verifyOrderAccessToken(ORDER_NUMBER, upper)).toBe(false)
	})

	it('rejects 32 non-hex characters', () => {
		expect(verifyOrderAccessToken(ORDER_NUMBER, 'z'.repeat(32))).toBe(false)
		expect(verifyOrderAccessToken(ORDER_NUMBER, '!'.repeat(32))).toBe(false)
	})

	it('rejects 32 chars whose UTF-8 byte length is not 32', () => {
		expect(verifyOrderAccessToken(ORDER_NUMBER, 'є'.repeat(32))).toBe(false)
	})

	it('never throws for arbitrary input', () => {
		const inputs: unknown[] = [
			undefined,
			null,
			0,
			42,
			true,
			{},
			[],
			() => token,
			Symbol('token'),
			'x'.repeat(1000),
			' '.repeat(32)
		]
		for (const input of inputs) {
			expect(() => verifyOrderAccessToken(ORDER_NUMBER, input as string)).not.toThrow()
			expect(verifyOrderAccessToken(ORDER_NUMBER, input as string)).toBe(false)
		}
		for (const input of inputs) {
			expect(() => verifyOrderAccessToken(input as string, token)).not.toThrow()
		}
	})
})

describe('liqpaySignature', () => {
	const privateKey = 'test-private-key'
	const data = Buffer.from(JSON.stringify({ order_id: ORDER_NUMBER, amount: 100 })).toString(
		'base64'
	)

	it('matches base64(sha1(private_key + data + private_key))', () => {
		const expected = createHash('sha1')
			.update(privateKey + data + privateKey)
			.digest('base64')
		expect(liqpaySignature(privateKey, data)).toBe(expected)
	})

	it('changes when the private key or data changes', () => {
		const base = liqpaySignature(privateKey, data)
		expect(liqpaySignature(`${privateKey}x`, data)).not.toBe(base)
		expect(liqpaySignature(privateKey, `${data}x`)).not.toBe(base)
	})
})

describe('verifyLiqpaySignature', () => {
	const privateKey = 'test-private-key'
	const data = Buffer.from('{"status":"success"}').toString('base64')
	const signature = liqpaySignature(privateKey, data)

	it('accepts the signature computed for the same key and data', () => {
		expect(verifyLiqpaySignature(privateKey, data, signature)).toBe(true)
	})

	it('rejects a tampered signature, a different length and a missing value', () => {
		const tampered = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A')
		expect(verifyLiqpaySignature(privateKey, data, tampered)).toBe(false)
		expect(verifyLiqpaySignature(privateKey, data, signature.slice(0, -2))).toBe(false)
		expect(verifyLiqpaySignature(privateKey, data, undefined as unknown as string)).toBe(false)
	})
})
