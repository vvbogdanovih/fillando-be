import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { PriceListService } from './price-list/price-list.service'
import { ProductController } from './product.controller'
import { ProductService } from './product.service'

const PRODUCT_ID = '000000000000000000000001'
const VARIANT_ID = '000000000000000000000002'

const resolved = () => jest.fn().mockResolvedValue({})

const productService = {
	findAll: resolved(),
	getCatalog: resolved(),
	search: resolved(),
	getAllVariantSlugs: resolved(),
	getVariantCount: resolved(),
	getPriceSheet: resolved(),
	getVariantBySlug: resolved(),
	findById: resolved(),
	validate: resolved(),
	create: resolved(),
	getVariants: resolved(),
	getVariant: resolved(),
	addVariant: resolved(),
	updateVariant: resolved(),
	deleteVariant: resolved(),
	setVariantImages: resolved(),
	update: resolved(),
	delete: resolved()
}

const priceListService = {
	generatePdf: jest.fn().mockResolvedValue({ buffer: Buffer.from('pdf'), filename: 'x.pdf' })
}

type ServiceMock = jest.Mock
type WriteRow = [method: HttpMethod, path: string, body: object | undefined, handler: ServiceMock]

const WRITE_ENDPOINTS: WriteRow[] = [
	['post', '/products/validate', {}, productService.validate],
	['post', '/products', {}, productService.create],
	['post', `/products/${PRODUCT_ID}/variants`, {}, productService.addVariant],
	['patch', `/products/${PRODUCT_ID}/variants/${VARIANT_ID}`, {}, productService.updateVariant],
	[
		'delete',
		`/products/${PRODUCT_ID}/variants/${VARIANT_ID}`,
		undefined,
		productService.deleteVariant
	],
	[
		'patch',
		`/products/${PRODUCT_ID}/variants/${VARIANT_ID}/images`,
		{},
		productService.setVariantImages
	],
	['patch', `/products/${PRODUCT_ID}`, {}, productService.update],
	['delete', `/products/${PRODUCT_ID}`, undefined, productService.delete],
	['post', '/products/price-list/pdf', {}, priceListService.generatePdf]
]

const PUBLIC_GETS: [path: string, handler: ServiceMock][] = [
	['/products', productService.findAll],
	['/products/catalog', productService.getCatalog],
	['/products/search', productService.search],
	['/products/variants/slugs', productService.getAllVariantSlugs],
	['/products/variants/count', productService.getVariantCount],
	['/products/price-sheet', productService.getPriceSheet],
	['/products/by-slug/x', productService.getVariantBySlug],
	[`/products/${PRODUCT_ID}`, productService.findById],
	[`/products/${PRODUCT_ID}/variants`, productService.getVariants],
	[`/products/${PRODUCT_ID}/variants/${VARIANT_ID}`, productService.getVariant]
]

describe('ProductController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [ProductController],
			providers: [
				{ provide: ProductService, useValue: productService },
				{ provide: PriceListService, useValue: priceListService }
			]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe('write endpoints are ADMIN-only', () => {
		it.each(WRITE_ENDPOINTS)(
			'%s %s → 401 without a token',
			async (method, path, body, handler) => {
				const res = await send(app, method, path, { body })

				expect(res.status).toBe(401)
				expect(handler).not.toHaveBeenCalled()
			}
		)

		it.each(WRITE_ENDPOINTS)('%s %s → 403 for USER', async (method, path, body, handler) => {
			const res = await send(app, method, path, { role: Role.USER, body })

			expect(res.status).toBe(403)
			expect(handler).not.toHaveBeenCalled()
		})

		it.each(WRITE_ENDPOINTS)('%s %s → 2xx for ADMIN', async (method, path, body, handler) => {
			const res = await send(app, method, path, { role: Role.ADMIN, body })

			expect(res.status).toBeGreaterThanOrEqual(200)
			expect(res.status).toBeLessThan(300)
			expect(handler).toHaveBeenCalledTimes(1)
		})

		it('passes control through the guard chain to the service exactly once for ADMIN', async () => {
			await send(app, 'post', '/products', { role: Role.ADMIN, body: { name: 'PLA' } })

			expect(productService.create).toHaveBeenCalledTimes(1)
			expect(productService.create).toHaveBeenCalledWith({ name: 'PLA' })
		})
	})

	describe('read endpoints stay public', () => {
		it.each(PUBLIC_GETS)('GET %s → 200 without a token', async (path, handler) => {
			const res = await send(app, 'get', path)

			expect(res.status).toBe(200)
			expect(handler).toHaveBeenCalledTimes(1)
		})
	})
})
