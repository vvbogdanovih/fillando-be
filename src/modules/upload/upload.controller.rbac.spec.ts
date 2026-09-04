import { INestApplication } from '@nestjs/common'
import { getLoggerToken } from 'nestjs-pino'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { UploadController } from './upload.controller'
import { UploadService } from './upload.service'

const resolved = () => jest.fn().mockResolvedValue({})

const uploadService = {
	generatePresignedUrls: resolved(),
	confirmUploads: resolved(),
	deleteFiles: resolved()
}

const noopLogger = {
	info() {},
	warn() {},
	error() {},
	debug() {}
}

type WriteRow = [method: HttpMethod, path: string, body: object, handler: jest.Mock]

// Handlers dereference `dto.files` / `dto.keys`, so every request carries a JSON body.
const ENDPOINTS: WriteRow[] = [
	['post', '/upload/presign', {}, uploadService.generatePresignedUrls],
	['post', '/upload/confirm', {}, uploadService.confirmUploads],
	['delete', '/upload', {}, uploadService.deleteFiles]
]

describe('UploadController RBAC (class-level guards)', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [UploadController],
			providers: [
				{ provide: UploadService, useValue: uploadService },
				{ provide: getLoggerToken(UploadController.name), useValue: noopLogger }
			]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	it.each(ENDPOINTS)('%s %s → 401 without a token', async (method, path, body, handler) => {
		const res = await send(app, method, path, { body })

		expect(res.status).toBe(401)
		expect(handler).not.toHaveBeenCalled()
	})

	it.each(ENDPOINTS)('%s %s → 403 for USER', async (method, path, body, handler) => {
		const res = await send(app, method, path, { role: Role.USER, body })

		expect(res.status).toBe(403)
		expect(handler).not.toHaveBeenCalled()
	})

	it.each(ENDPOINTS)('%s %s → 2xx for ADMIN', async (method, path, body, handler) => {
		const res = await send(app, method, path, { role: Role.ADMIN, body })

		expect(res.status).toBeGreaterThanOrEqual(200)
		expect(res.status).toBeLessThan(300)
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('passes control through the guard chain to the service exactly once for ADMIN', async () => {
		await send(app, 'delete', '/upload', { role: Role.ADMIN, body: { keys: ['a.webp'] } })

		expect(uploadService.deleteFiles).toHaveBeenCalledTimes(1)
		expect(uploadService.deleteFiles).toHaveBeenCalledWith(['a.webp'])
	})
})
