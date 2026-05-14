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
		if (keys.length === 1) {
			await this.s3.send(
				new DeleteObjectCommand({ Bucket: ENV.AWS_S3_BUCKET_NAME, Key: keys[0] })
			)
		} else {
			await this.s3.send(
				new DeleteObjectsCommand({
					Bucket: ENV.AWS_S3_BUCKET_NAME,
					Delete: { Objects: keys.map(Key => ({ Key })) }
				})
			)
		}
		this.logger.log(`Deleted ${keys.length} file(s) from S3`)
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

	private async confirmAndConvert(key: string) {
		const head = await this.s3.send(
			new HeadObjectCommand({ Bucket: ENV.AWS_S3_BUCKET_NAME, Key: key })
		)

		const contentType = head.ContentType ?? ''
		if (!CONVERTIBLE_TYPES.includes(contentType)) return

		const obj = await this.s3.send(
			new GetObjectCommand({ Bucket: ENV.AWS_S3_BUCKET_NAME, Key: key })
		)

		const original = Buffer.from(await obj.Body!.transformToByteArray())
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

		this.logger.log(`Converted ${key} (${contentType}) to WebP`)
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
