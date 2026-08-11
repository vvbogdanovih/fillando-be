import { Injectable, Logger } from '@nestjs/common'
import {
	S3Client,
	HeadObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	PutObjectCommand
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import sharp from 'sharp'
import { ENV } from 'src/common/constants'
import {
	FilePresignRequestDto,
	UploadEntityType,
	UploadContentType
} from './dto/presign-upload.dto'

const CONTENT_TYPE_TO_EXT: Record<UploadContentType, string> = {
	[UploadContentType.JPEG]: 'jpg',
	[UploadContentType.PNG]: 'png',
	[UploadContentType.WEBP]: 'webp'
}

const PRESIGN_EXPIRES_IN = 900 // 15 minutes
const WEBP_QUALITY = 80
const CONVERTIBLE_TYPES = ['image/jpeg', 'image/png']

/**
 * Width tiers written alongside every uploaded image, consumed by the frontend's
 * custom next/image loader (`image-loader.ts`).
 *
 * Sharp runs once here, at upload time — never per request. The Next image
 * optimizer is deliberately disabled (`images.unoptimized`) because it would
 * download and decode the full S3 object on every cache miss and can exhaust a
 * 1–2 GB VPS.
 *
 * Keep in sync with `TIERS` in the frontend loader. Every tier must exist for
 * every image: the browser picks a candidate from the srcset and a missing
 * derivative is a hard 404 with no fallback.
 */
const DERIVATIVE_WIDTHS = [128, 320, 640, 1280] as const
const DERIVATIVE_SUFFIX = /-(?:128|320|640|1280)\.webp$/
const IMAGE_KEY_EXT = /\.(jpg|jpeg|png|webp)$/i

@Injectable()
export class UploadService {
	private readonly logger = new Logger(UploadService.name)
	private readonly s3: S3Client

	constructor() {
		this.s3 = new S3Client({
			region: ENV.AWS_REGION,
			credentials: {
				accessKeyId: ENV.AWS_ACCESS_KEY_ID,
				secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY
			},
			// Disable automatic checksums so presigned PUT URLs work from the browser.
			// Without this, SDK v3 adds x-amz-checksum-crc32 to the URL which S3 then
			// requires the browser to send as a header — impossible in a cross-origin context.
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED'
		})
	}

	async generatePresignedUrls(files: FilePresignRequestDto[]) {
		const results = await Promise.all(files.map(file => this.generatePresignedUrl(file)))
		return { files: results }
	}

	async confirmUploads(keys: string[]) {
		const results = await Promise.allSettled(keys.map(key => this.confirmAndConvert(key)))
		const confirmed: string[] = []
		const failed: string[] = []
		keys.forEach((key, i) => {
			if (results[i].status === 'fulfilled') confirmed.push(key)
			else failed.push(key)
		})
		return { confirmed, failed }
	}

	async deleteFiles(keys: string[]) {
		if (keys.length === 0) return

		// Each original has a set of width derivatives that would otherwise orphan.
		const allKeys = keys.flatMap(key => [key, ...this.derivativeKeys(key)])

		if (allKeys.length === 1) {
			await this.s3.send(
				new DeleteObjectCommand({ Bucket: ENV.AWS_S3_BUCKET_NAME, Key: allKeys[0] })
			)
		} else {
			// DeleteObjects caps at 1000 keys per call.
			for (let i = 0; i < allKeys.length; i += 1000) {
				await this.s3.send(
					new DeleteObjectsCommand({
						Bucket: ENV.AWS_S3_BUCKET_NAME,
						Delete: { Objects: allKeys.slice(i, i + 1000).map(Key => ({ Key })) }
					})
				)
			}
		}
		this.logger.log(`Deleted ${keys.length} file(s) (+derivatives) from S3`)
	}

	private derivativeKeys(key: string): string[] {
		// Guard against a derivative key being passed in and fanning out again.
		if (DERIVATIVE_SUFFIX.test(key)) return []
		const base = key.replace(IMAGE_KEY_EXT, '')
		return DERIVATIVE_WIDTHS.map(width => `${base}-${width}.webp`)
	}

	private async generatePresignedUrl(file: FilePresignRequestDto) {
		const key = this.buildKey(file)
		const command = new PutObjectCommand({
			Bucket: ENV.AWS_S3_BUCKET_NAME,
			Key: key,
			ContentType: file.contentType,
			CacheControl: 'public, max-age=31536000, immutable'
		})
		const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: PRESIGN_EXPIRES_IN })
		const publicUrl = `${ENV.AWS_S3_PUBLIC_URL}/${key}`
		return { key, uploadUrl, publicUrl }
	}

	/**
	 * Writes every width tier for `key`. Public so the backfill migration
	 * (`scripts/migrations/generate-image-derivatives.js`) can reuse the same logic.
	 *
	 * Tiers are written unconditionally: `withoutEnlargement` turns a tier wider than
	 * the source into a copy at the source width, which is what we want — the frontend
	 * always emits a 1280w srcset candidate even for a 1254px original, and a missing
	 * object would be a broken image.
	 */
	async writeDerivatives(key: string, original: Buffer) {
		const base = key.replace(IMAGE_KEY_EXT, '')

		for (const width of DERIVATIVE_WIDTHS) {
			// `resize({ width })` only — passing height too would letterbox a portrait
			// source down to a narrower image that is still published at this tier's width.
			const buffer = await sharp(original)
				.resize({ width, withoutEnlargement: true })
				.webp({ quality: WEBP_QUALITY })
				.toBuffer()

			await this.s3.send(
				new PutObjectCommand({
					Bucket: ENV.AWS_S3_BUCKET_NAME,
					Key: `${base}-${width}.webp`,
					Body: buffer,
					ContentType: 'image/webp',
					CacheControl: 'public, max-age=31536000, immutable'
				})
			)
		}
	}

	private async confirmAndConvert(key: string) {
		const head = await this.s3.send(
			new HeadObjectCommand({ Bucket: ENV.AWS_S3_BUCKET_NAME, Key: key })
		)

		const contentType = head.ContentType ?? ''

		const obj = await this.s3.send(
			new GetObjectCommand({ Bucket: ENV.AWS_S3_BUCKET_NAME, Key: key })
		)
		const original = Buffer.from(await obj.Body!.transformToByteArray())

		// Derivatives are written for EVERY image, deliberately outside the
		// CONVERTIBLE_TYPES gate below: a direct WebP upload needs its tiers just as
		// much as a JPEG does, and already-converted objects report `image/webp`.
		await this.writeDerivatives(key, original)

		if (!CONVERTIBLE_TYPES.includes(contentType)) {
			this.logger.log(`Wrote ${DERIVATIVE_WIDTHS.length} derivative(s) for ${key}`)
			return
		}

		const webpBuffer = await sharp(original).webp({ quality: WEBP_QUALITY }).toBuffer()

		await this.s3.send(
			new PutObjectCommand({
				Bucket: ENV.AWS_S3_BUCKET_NAME,
				Key: key,
				Body: webpBuffer,
				ContentType: 'image/webp',
				CacheControl: 'public, max-age=31536000, immutable'
			})
		)

		this.logger.log(
			`Converted ${key} (${contentType}) to WebP + ${DERIVATIVE_WIDTHS.length} derivative(s)`
		)
	}

	private buildKey(file: FilePresignRequestDto): string {
		const ext = CONTENT_TYPE_TO_EXT[file.contentType]
		const uuid = randomUUID()
		switch (file.entityType) {
			case UploadEntityType.PRODUCT:
				return `products/${file.entityId}/${uuid}.${ext}`
			case UploadEntityType.USER:
				return `users/${file.entityId}/avatar/${uuid}.${ext}`
			case UploadEntityType.VENDOR:
				return `vendors/${file.entityId}/${uuid}.${ext}`
			case UploadEntityType.CATEGORY:
				return `categories/${file.entityId}/${uuid}.${ext}`
		}
	}
}
