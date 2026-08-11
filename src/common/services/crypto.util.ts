import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual
} from 'node:crypto'
import { ENV } from 'src/common/constants'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

// Derive a fixed 32-byte AES-256 key from the configured secret via SHA-256.
// This accepts any sufficiently long secret regardless of its encoding.
function getKey(): Buffer {
	return createHash('sha256').update(ENV.PAYMENT_ENCRYPTION_KEY).digest()
}

/**
 * Encrypts a plaintext secret with AES-256-GCM.
 * Output format: `iv:authTag:ciphertext`, each part base64-encoded.
 */
export function encrypt(plain: string): string {
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALGORITHM, getKey(), iv)
	const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
	const authTag = cipher.getAuthTag()
	return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
		':'
	)
}

/**
 * Decrypts a value produced by {@link encrypt}. Throws on tampering or bad key.
 */
export function decrypt(payload: string): string {
	const [ivB64, tagB64, dataB64] = payload.split(':')
	if (!ivB64 || !tagB64 || !dataB64) {
		throw new Error('Invalid encrypted payload format')
	}
	const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'))
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
	const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
	return plain.toString('utf8')
}

/**
 * LiqPay signature: base64(sha1(private_key + data + private_key)).
 * `data` is the base64-encoded request payload.
 */
export function liqpaySignature(privateKey: string, data: string): string {
	return createHash('sha1')
		.update(privateKey + data + privateKey)
		.digest('base64')
}

/**
 * Constant-time comparison of an incoming LiqPay signature against the expected one.
 */
export function verifyLiqpaySignature(
	privateKey: string,
	data: string,
	signature: string
): boolean {
	const expected = Buffer.from(liqpaySignature(privateKey, data))
	const received = Buffer.from(signature ?? '')
	if (expected.length !== received.length) return false
	return timingSafeEqual(expected, received)
}
