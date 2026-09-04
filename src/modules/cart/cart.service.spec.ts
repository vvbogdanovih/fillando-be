import { ConflictException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ProductStatus } from 'src/common/types/enums'
import { CartService } from './cart.service'

/**
 * Draft/archived variants are hidden from every public read (plan-0003 PR-2); the cart must
 * treat them exactly like out-of-stock so they cannot be added or kept by id.
 */
const USER_ID = '64b8f0000000000000000010'
const ACTIVE_ID = '64b8f0000000000000000001'
const DRAFT_ID = '64b8f0000000000000000002'

const buildVariant = (id: string, overrides: Record<string, unknown> = {}) => ({
	_id: new Types.ObjectId(id),
	name: `Variant ${id.slice(-1)}`,
	slug: `variant-${id.slice(-1)}`,
	price: 500,
	stock: 10,
	status: ProductStatus.ACTIVE,
	images: [],
	v_value: null,
	...overrides
})

const ACTIVE = buildVariant(ACTIVE_ID)
const DRAFT = buildVariant(DRAFT_ID, { status: ProductStatus.DRAFT })

const buildService = (cart: { items: Array<Record<string, unknown>> } | null) => {
	const cartRepository = {
		findByUserId: jest.fn().mockResolvedValue(cart),
		update: jest
			.fn()
			.mockImplementation((_filter, payload) =>
				Promise.resolve({ items: payload.$set.items })
			),
		upsertByUserId: jest
			.fn()
			.mockImplementation((_userId, payload) =>
				Promise.resolve({ items: payload.$set.items })
			)
	}
	const productVariantRepository = {
		findById: jest
			.fn()
			.mockImplementation((id: string) =>
				Promise.resolve([ACTIVE, DRAFT].find(v => v._id.toString() === id) ?? null)
			),
		findByIds: jest.fn().mockImplementation((ids: Types.ObjectId[]) => {
			const wanted = new Set(ids.map(String))
			return Promise.resolve([ACTIVE, DRAFT].filter(v => wanted.has(v._id.toString())))
		})
	}
	const service = new CartService(cartRepository as never, productVariantRepository as never)
	return { service, cartRepository }
}

const cartWith = (...ids: string[]) => ({
	items: ids.map(id => ({
		variant_id: new Types.ObjectId(id),
		quantity: 1,
		added_at: new Date()
	}))
})

describe('CartService — non-active variants are unavailable', () => {
	it('addItem rejects a DRAFT variant with 409 and writes nothing', async () => {
		const { service, cartRepository } = buildService(null)

		await expect(
			service.addItem(USER_ID, { variant_id: DRAFT_ID, quantity: 1 })
		).rejects.toBeInstanceOf(ConflictException)

		expect(cartRepository.upsertByUserId).not.toHaveBeenCalled()
	})

	it('addItem still accepts an ACTIVE variant', async () => {
		const { service, cartRepository } = buildService(null)

		const result = await service.addItem(USER_ID, { variant_id: ACTIVE_ID, quantity: 2 })

		expect(cartRepository.upsertByUserId).toHaveBeenCalledTimes(1)
		expect(result.items).toHaveLength(1)
		expect(result.removed_items).toEqual([])
	})

	it('updateItem rejects a DRAFT variant with 409', async () => {
		const { service, cartRepository } = buildService(cartWith(DRAFT_ID))

		await expect(service.updateItem(USER_ID, DRAFT_ID, { quantity: 3 })).rejects.toBeInstanceOf(
			ConflictException
		)

		expect(cartRepository.update).not.toHaveBeenCalled()
	})

	it('getCart drops a DRAFT variant into removed_items and persists the cleaned cart', async () => {
		const { service, cartRepository } = buildService(cartWith(ACTIVE_ID, DRAFT_ID))

		const result = await service.getCart(USER_ID)

		expect(result.removed_items).toEqual([DRAFT_ID])
		expect(result.items.map(i => i.variant_id)).toEqual([ACTIVE_ID])
		expect(cartRepository.update).toHaveBeenCalledTimes(1)
	})

	it('mergeCart skips DRAFT guest items', async () => {
		const { service } = buildService(null)

		const result = await service.mergeCart(USER_ID, {
			items: [
				{ variant_id: ACTIVE_ID, quantity: 1 },
				{ variant_id: DRAFT_ID, quantity: 1 }
			]
		})

		expect(result.removed_items).toEqual([DRAFT_ID])
		expect(result.items.map(i => i.variant_id)).toEqual([ACTIVE_ID])
	})
})
