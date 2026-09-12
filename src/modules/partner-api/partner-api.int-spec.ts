import mongoose, { Types } from 'mongoose'
import { connectTestDb, dropTestDb } from '../../../test/integration-db'
import {
	PartnerApiToken,
	PartnerApiTokenSchema
} from 'src/database/mongoose/schemas/partner-api-token.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { PartnerApiRepository } from 'src/database/mongoose/repositories/partner-api.repository'
import { PartnerApiService } from './partner-api.service'

describe('Partner API MongoDB lifecycle', () => {
	let conn: typeof mongoose
	let service: PartnerApiService
	beforeAll(async () => {
		conn = await connectTestDb('partner-api')
		const tokens = conn.model(PartnerApiToken.name, PartnerApiTokenSchema)
		const variants = conn.model(ProductVariant.name, ProductVariantSchema)
		await tokens.init()
		service = new PartnerApiService(new PartnerApiRepository(tokens, variants))
		await variants.insertMany(
			['active', 'draft', 'archived'].map((status, i) => ({
				product_id: new Types.ObjectId(),
				category_id: new Types.ObjectId(),
				name: 'Fixture',
				slug: 'fixture-' + i,
				sku: 'FL-' + i,
				price: 500,
				stock: 12,
				status,
				prom_id: 'secret'
			}))
		)
	})
	afterAll(async () => {
		if (conn) await dropTestDb(conn)
	})
	it('creates a hashed token, authenticates, lists safe metadata and revokes idempotently', async () => {
		const created = await service.create('CRM', new Types.ObjectId().toString())
		expect(await service.authenticate('Bearer ' + created.token)).toBe(created.id)
		const stored = await conn.connection
			.collection('partner_api_tokens')
			.findOne({ _id: new Types.ObjectId(created.id) })
		expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.stringify(stored)).not.toContain(created.token)
		const listed = await service.list()
		expect(listed[0].id).toBe(created.id)
		expect(JSON.stringify(listed)).not.toContain('token_hash')
		expect(JSON.stringify(listed)).not.toContain(created.token)
		await service.revoke(created.id)
		const revoked = (await service.list())[0].revoked_at
		expect(revoked).toBeInstanceOf(Date)
		await service.revoke(created.id)
		expect((await service.list())[0].revoked_at).toEqual(revoked)
		await expect(service.authenticate('Bearer ' + created.token)).rejects.toMatchObject({
			status: 401
		})
	})
	it('only returns active variants with exact SKU matching', async () => {
		expect(await service.availability('FL-0')).toEqual({
			sku: 'FL-0',
			in_stock: true,
			quantity: 12,
			stock_updated_at: null
		})
		for (const sku of ['FL-1', 'FL-2', 'fl-0', 'FL-unknown']) {
			await expect(service.availability(sku)).rejects.toMatchObject({ status: 404 })
		}
	})
	it('bulk reads exclude inactive variants and preserve the exact SKU contract', async () => {
		expect(
			await service.bulkAvailability(['FL-2', 'FL-0', 'fl-0', 'FL-1', 'FL-0', 'unknown'])
		).toEqual({
			items: [{ sku: 'FL-0', in_stock: true, quantity: 12, stock_updated_at: null }],
			not_found: ['FL-2', 'fl-0', 'FL-1', 'unknown']
		})
	})
})
