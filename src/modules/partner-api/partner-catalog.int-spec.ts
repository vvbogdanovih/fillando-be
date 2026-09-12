import mongoose, { Types } from 'mongoose'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import { Category, CategorySchema } from 'src/database/mongoose/schemas/category.schema'
import { Product, ProductSchema } from 'src/database/mongoose/schemas/product.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { PartnerCatalogRepository } from 'src/database/mongoose/repositories/partner-catalog.repository'
import { PartnerCatalogService } from './partner-catalog.service'

describe('Partner catalogue MongoDB', () => {
	let conn: typeof mongoose
	let service: PartnerCatalogService
	const catA = new Types.ObjectId()
	const catB = new Types.ObjectId()
	const empty = new Types.ObjectId()
	const prodA = new Types.ObjectId()
	const prodB = new Types.ObjectId()
	beforeAll(async () => {
		conn = await connectTestDb('partner-catalog')
		const categories = conn.model(Category.name, CategorySchema)
		const products = conn.model(Product.name, ProductSchema)
		const variants = conn.model(ProductVariant.name, ProductVariantSchema)
		await categories.insertMany([
			{ _id: catA, name: 'A', slug: 'a', order: 1 },
			{ _id: catB, name: 'B', slug: 'b', order: 2 },
			{ _id: empty, name: 'Empty', slug: 'empty', order: 3 }
		])
		await products.insertMany([
			{
				_id: prodA,
				name: 'PLA',
				category_id: catA,
				vendor_id: new Types.ObjectId(),
				description: { html: '<p>PLA</p>', json: { internal: 'not exported' } },
				attributes: [{ k: 'spool', l: 'Котушка', v: false }],
				variant_type: { key: 'color', label: 'Колір' }
			},
			{ _id: prodB, name: 'ABS', category_id: catB, vendor_id: new Types.ObjectId() }
		])
		const fixtures = [
			{ sku: 'A003', product_id: prodA, category_id: catA },
			{ sku: 'A001', product_id: prodA, category_id: catA },
			{ sku: 'B002', product_id: prodB, category_id: catB },
			{ sku: 'draft', product_id: prodA, category_id: catA, status: 'draft' },
			{ sku: 'archived', product_id: prodA, category_id: catA, status: 'archived' },
			{ sku: 'orphan', product_id: new Types.ObjectId(), category_id: catA },
			{ sku: 'mismatch', product_id: prodB, category_id: catA },
			{ sku: 'no-category', product_id: prodA, category_id: new Types.ObjectId() }
		]
		await variants.insertMany(
			fixtures.map(f => ({
				name: 'Variant',
				slug: f.sku,
				stock: 0,
				price: 500.25,
				prom_base_price: 10,
				prom_id: 'secret',
				vendor_product_sku: 'secret',
				v_value: 'Black',
				weight_g: 0,
				...f
			}))
		)
		service = new PartnerCatalogService(new PartnerCatalogRepository(categories, variants))
	})
	afterAll(async () => {
		if (conn) await dropTestDb(conn)
	})
	it('counts only exportable variants and includes empty categories', async () => {
		expect(await service.categories()).toEqual([
			{ id: catA.toString(), name: 'A', slug: 'a', parent_id: null, sku_count: 2 },
			{ id: catB.toString(), name: 'B', slug: 'b', parent_id: null, sku_count: 1 },
			{ id: empty.toString(), name: 'Empty', slug: 'empty', parent_id: null, sku_count: 0 }
		])
	})
	it('enumerates the full catalogue with no duplicates or omissions', async () => {
		const first = await service.skus({ limit: 1 })
		expect(first.items).toEqual(['A001'])
		expect(first.next_cursor).not.toBeNull()
		const next = await service.skus({ limit: 1, cursor: first.next_cursor! })
		expect(next.items).toEqual(['A003'])
		const last = await service.skus({ limit: 1, cursor: next.next_cursor! })
		expect(last).toEqual({ items: ['B002'], next_cursor: null })
	})
	it('filters a category, handles zero results and rejects missing categories', async () => {
		expect(await service.skus({ category_id: catA.toString(), limit: 100 })).toEqual({
			items: ['A001', 'A003'],
			next_cursor: null
		})
		expect(await service.skus({ category_id: empty.toString(), limit: 100 })).toEqual({
			items: [],
			next_cursor: null
		})
		await expect(
			service.skus({ category_id: new Types.ObjectId().toString(), limit: 100 })
		).rejects.toMatchObject({ status: 404 })
	})
	it('lookup exposes only public fields and preserves request order', async () => {
		const result = await service.lookup([
			'B002',
			'A003',
			'draft',
			'archived',
			'orphan',
			'mismatch',
			'no-category',
			'a001',
			'B002'
		])
		expect(result.items.map(item => item.sku)).toEqual(['B002', 'A003'])
		expect(result.not_found).toEqual([
			'draft',
			'archived',
			'orphan',
			'mismatch',
			'no-category',
			'a001'
		])
		expect(result.items[1]).toEqual({
			sku: 'A003',
			name: 'Variant',
			price: 500.25,
			currency: 'UAH',
			description_html: '<p>PLA</p>',
			category: { id: catA.toString(), name: 'A', slug: 'a' },
			attributes: [{ key: 'spool', label: 'Котушка', value: false }],
			variant: { key: 'color', label: 'Колір', value: 'Black' },
			images: [],
			url: expect.stringMatching(/\/products\/A003$/) as string,
			weight_g: null,
			availability: { sku: 'A003', in_stock: false, quantity: 0, stock_updated_at: null }
		})
		expect(result.items[0].description_html).toBeNull()
		expect(result.items[0].attributes).toEqual([])
		expect(result.items[0].variant).toBeNull()
		expect(JSON.stringify(result)).not.toContain('secret')
		expect(JSON.stringify(result)).not.toContain('vendor_id')
		expect(JSON.stringify(result)).not.toContain('prom_base_price')
	})
})
