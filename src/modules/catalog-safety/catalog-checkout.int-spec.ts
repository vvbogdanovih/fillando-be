import mongoose, { Types } from 'mongoose'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { LegacyCatalogWritePolicy } from './legacy-catalog-write.interceptor'
import { OrderService } from '../order/order.service'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import {
	DeliveryMethod,
	PaymentMethod,
	PaymentStatus,
	OrderStatus,
	ProductStatus
} from 'src/common/types/enums'
const variantId = new Types.ObjectId(),
	orderId = new Types.ObjectId()
const line = {
	variant_id: variantId,
	product_id: new Types.ObjectId(),
	name: 'AVR',
	sku: 'AVR-1',
	price: 100,
	quantity: 2
}
const dto = {
	items: [{ variant_id: String(variantId), quantity: 1 }],
	customer: { name: 'Test', phone: '+380000000000', email: 'test@example.invalid' },
	payment_method: PaymentMethod.CASH,
	delivery_method: DeliveryMethod.PICKUP
}
let service: OrderService
const variants = { findByIds: jest.fn() }
const numbers = { increment: jest.fn() }
const orders = {
	create: jest.fn(),
	update: jest.fn(),
	findById: jest.fn(),
	findByOrderNumber: jest.fn()
}
const coupons = { findActiveByCode: jest.fn() }
const fixture = () => ({
	_id: orderId,
	order_number: 'FO-0000001',
	items: [line],
	subtotal_price: 200,
	total_price: 200,
	customer: dto.customer,
	payment_method: PaymentMethod.CASH,
	payment_status: PaymentStatus.PENDING,
	order_status: OrderStatus.NEW,
	delivery_method: DeliveryMethod.PICKUP,
	applied_discount: null
})
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('catalog-checkout')
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	jest.resetAllMocks()
	variants.findByIds.mockResolvedValue([
		{
			_id: variantId,
			product_id: line.product_id,
			sku: line.sku,
			name: line.name,
			status: ProductStatus.ACTIVE,
			stock: 10,
			price: 100
		}
	])
	numbers.increment.mockRejectedValue(Error('STOP_BEFORE_WRITE'))
	orders.findById.mockResolvedValue(fixture())
	orders.update.mockImplementation((_filter: unknown, update: { $set: object }) =>
		Promise.resolve({ ...fixture(), ...update.$set })
	)
	service = new OrderService(
		orders as never,
		numbers as never,
		variants as never,
		coupons as never,
		{} as never,
		{} as never,
		{} as never,
		new LegacyCatalogWritePolicy(mongoose.connection)
	)
})
afterAll(async () => {
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
async function control(phase = 'idle') {
	await mongoose.connection
		.db!.collection<{ _id: string }>('catalog_control')
		.insertOne({ _id: 'catalog', phase, revision: 0, epoch: 0 } as never)
}
it('allows a stable snapshot through to the next step without automatically initializing control', async () => {
	await expect(service.create(dto)).rejects.toThrow('STOP_BEFORE_WRITE')
	expect(numbers.increment).toHaveBeenCalledTimes(1)
	expect(await mongoose.connection.collection('catalog_control').countDocuments()).toBe(0)
})
it('refuses checkout before variants, coupons, number allocation and order writes during maintenance', async () => {
	await control('writing')
	await expect(service.create({ ...dto, coupon_code: 'TEST' })).rejects.toMatchObject({
		status: 503
	})
	for (const fn of [
		variants.findByIds,
		coupons.findActiveByCode,
		numbers.increment,
		orders.create
	])
		expect(fn).not.toHaveBeenCalled()
})
it('discards changed catalog rows before coupon consumption or order writes', async () => {
	await control()
	variants.findByIds.mockImplementationOnce(async () => {
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { epoch: 1 } })
		return []
	})
	await expect(service.create({ ...dto, coupon_code: 'TEST' })).rejects.toMatchObject({
		status: 503,
		response: { details: { code: 'CATALOG_READ_CHANGED' } }
	})
	for (const fn of [coupons.findActiveByCode, numbers.increment, orders.create])
		expect(fn).not.toHaveBeenCalled()
})
it('blocks increasing an existing line but permits reducing its saved snapshot during maintenance', async () => {
	await control('writing')
	await expect(
		service.update(String(orderId), { items: [{ variant_id: String(variantId), quantity: 3 }] })
	).rejects.toMatchObject({ status: 503 })
	expect(orders.update).not.toHaveBeenCalled()
	const reduced = await service.update(String(orderId), {
		items: [{ variant_id: String(variantId), quantity: 1 }]
	})
	expect(reduced.total_price).toBe(100)
	expect(orders.update).toHaveBeenCalledTimes(1)
	expect(variants.findByIds).not.toHaveBeenCalled()
})
it('rejects new admin lines under incompatible v2 before persisting edits', async () => {
	await control()
	await mongoose.connection.collection('categories').insertOne({ attribute_contract_version: 2 })
	await expect(
		service.update(String(orderId), {
			items: [{ variant_id: String(new Types.ObjectId()), quantity: 1 }]
		})
	).rejects.toMatchObject({ status: 503 })
	expect(orders.update).not.toHaveBeenCalled()
})
it('continues gateway result handling for an existing order while the catalog is locked', async () => {
	await control('recovery_required')
	orders.findByOrderNumber.mockResolvedValue({
		...fixture(),
		payment_method: PaymentMethod.LIQPAY
	})
	await service.applyGatewayPaymentResult('FO-0000001', false, 'test-txn')
	expect(orders.update).toHaveBeenCalledTimes(1)
	const writes = orders.update.mock.calls as Array<
		[unknown, { $set: { payment_status: PaymentStatus } }]
	>
	expect(writes[0][1].$set.payment_status).toBe(PaymentStatus.FAILED)
	expect(variants.findByIds).not.toHaveBeenCalled()
})

describe('typed catalogue adapter (TD-0013)', () => {
	const visibleCategory = new Types.ObjectId(),
		hiddenCategory = new Types.ObjectId(),
		draftGroup = new Types.ObjectId()
	const adapted = () =>
		new OrderService(
			orders as never,
			numbers as never,
			variants as never,
			coupons as never,
			{} as never,
			{} as never,
			{} as never,
			new LegacyCatalogWritePolicy(mongoose.connection),
			new CategoryPublicReadService(mongoose.connection)
		)
	beforeEach(async () => {
		await control()
		const definitions: unknown[] = []
		await mongoose.connection.collection('categories').insertMany([
			{
				_id: visibleCategory,
				name: 'АВР',
				slug: 'avr',
				kind: 'product',
				status: 'active',
				attribute_contract_version: 2,
				attribute_definitions: definitions
			},
			{
				_id: draftGroup,
				name: 'Чернетка',
				slug: 'draft',
				kind: 'group',
				status: 'draft',
				attribute_contract_version: 2,
				attribute_definitions: definitions
			},
			{
				_id: hiddenCategory,
				name: 'Прихована',
				slug: 'hidden',
				kind: 'product',
				status: 'active',
				parent_id: draftGroup,
				attribute_contract_version: 2,
				attribute_definitions: definitions
			}
		])
	})
	const sku = (category: Types.ObjectId) => ({
		_id: variantId,
		product_id: line.product_id,
		category_id: category,
		sku: line.sku,
		name: line.name,
		status: ProductStatus.ACTIVE,
		stock: 10,
		price: 100
	})
	it('lets an active SKU of a public v2 category reach the order write', async () => {
		variants.findByIds.mockResolvedValue([sku(visibleCategory)])
		await expect(adapted().create(dto)).rejects.toThrow('STOP_BEFORE_WRITE')
		expect(numbers.increment).toHaveBeenCalledTimes(1)
	})
	it('refuses an active SKU of a hidden branch before any number or order write', async () => {
		variants.findByIds.mockResolvedValue([sku(hiddenCategory)])
		await expect(adapted().create(dto)).rejects.toMatchObject({
			status: 400,
			response: { code: 'VARIANT_UNAVAILABLE' }
		})
		expect(numbers.increment).not.toHaveBeenCalled()
		expect(orders.create).not.toHaveBeenCalled()
	})
	it('keeps the maintenance barrier on the adapted read', async () => {
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $set: { phase: 'writing' } })
		await expect(adapted().create(dto)).rejects.toMatchObject({ status: 503 })
		expect(variants.findByIds).not.toHaveBeenCalled()
	})
})
