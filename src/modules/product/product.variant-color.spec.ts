import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ColorFamily } from 'src/common/types/enums'
import { ProductService } from './product.service'

/**
 * `ProductVariant.color_family` is a denormalized copy of `Color.family` (TD-0002 §5.2.2), so it
 * must never come from the client: the admin sends a `color_id` and the service looks the family
 * up. If that ever slips, the swatch filter starts disagreeing with the colour on the product
 * page, and nothing errors — the variant simply stops appearing under its own colour.
 */
const PRODUCT_ID = '000000000000000000000001'
const VARIANT_ID = '000000000000000000000002'
const COLOR_ID = '000000000000000000000003'

const buildService = (
	color: unknown = { _id: new Types.ObjectId(COLOR_ID), family: ColorFamily.RED }
) => {
	const productRepository = {
		findById: jest.fn().mockResolvedValue({
			_id: new Types.ObjectId(PRODUCT_ID),
			name: 'PLA',
			category_id: new Types.ObjectId('000000000000000000000c01')
		})
	}
	const productVariantRepository = {
		create: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
		update: jest.fn().mockImplementation((_f: unknown, data: unknown) => Promise.resolve(data))
	}
	const numbersRepository = { increment: jest.fn().mockResolvedValue({ value: 42 }) }
	const colorRepository = { findById: jest.fn().mockResolvedValue(color) }
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		numbersRepository as never,
		colorRepository as never
	)
	return { service, productVariantRepository, colorRepository }
}

describe('addVariant — colour', () => {
	it('stores the dictionary family alongside the id', async () => {
		const { service, productVariantRepository } = buildService()

		await service.addVariant(PRODUCT_ID, { price: 100, color_id: COLOR_ID } as never)

		const written = productVariantRepository.create.mock.calls[0][0] as Record<string, unknown>
		expect(written.color_family).toBe(ColorFamily.RED)
		expect(String(written.color_id)).toBe(COLOR_ID)
	})

	it('stores color_id as an ObjectId, not the string it arrived as', async () => {
		const { service, productVariantRepository } = buildService()

		await service.addVariant(PRODUCT_ID, { price: 100, color_id: COLOR_ID } as never)

		const written = productVariantRepository.create.mock.calls[0][0] as Record<string, unknown>
		expect(written.color_id).toBeInstanceOf(Types.ObjectId)
	})

	it('ignores a family the client tries to send', async () => {
		const { service, productVariantRepository } = buildService()

		await service.addVariant(PRODUCT_ID, {
			price: 100,
			color_id: COLOR_ID,
			color_family: ColorFamily.BLUE
		} as never)

		const written = productVariantRepository.create.mock.calls[0][0] as Record<string, unknown>
		expect(written.color_family).toBe(ColorFamily.RED)
	})

	it('leaves both fields alone when the request says nothing about colour', async () => {
		const { service, productVariantRepository, colorRepository } = buildService()

		await service.addVariant(PRODUCT_ID, { price: 100 } as never)

		const written = productVariantRepository.create.mock.calls[0][0] as Record<string, unknown>
		expect(written).not.toHaveProperty('color_family')
		expect(colorRepository.findById).not.toHaveBeenCalled()
	})

	it('refuses a colour the dictionary does not know instead of storing a dangling id', async () => {
		const { service, productVariantRepository } = buildService(null)

		await expect(
			service.addVariant(PRODUCT_ID, { price: 100, color_id: COLOR_ID } as never)
		).rejects.toBeInstanceOf(BadRequestException)
		expect(productVariantRepository.create).not.toHaveBeenCalled()
	})

	it('refuses a malformed id without touching the dictionary', async () => {
		const { service, colorRepository } = buildService()

		await expect(
			service.addVariant(PRODUCT_ID, { price: 100, color_id: 'not-an-id' } as never)
		).rejects.toBeInstanceOf(BadRequestException)
		expect(colorRepository.findById).not.toHaveBeenCalled()
	})
})

describe('updateVariant — colour', () => {
	it('rewrites both fields together', async () => {
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { color_id: COLOR_ID } as never)

		const patch = productVariantRepository.update.mock.calls[0][1] as Record<string, unknown>
		expect(patch.color_family).toBe(ColorFamily.RED)
		expect(String(patch.color_id)).toBe(COLOR_ID)
	})

	it('clears the family when the colour is cleared', async () => {
		// Leaving a stale `color_family` behind would keep the variant in a swatch bucket it no
		// longer belongs to.
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { color_id: null } as never)

		const patch = productVariantRepository.update.mock.calls[0][1] as Record<string, unknown>
		expect(patch.color_id).toBeNull()
		expect(patch.color_family).toBeNull()
	})

	it('does not touch colour on an unrelated edit', async () => {
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { price: 250 } as never)

		const patch = productVariantRepository.update.mock.calls[0][1] as Record<string, unknown>
		expect(patch).not.toHaveProperty('color_id')
		expect(patch).not.toHaveProperty('color_family')
	})

	it('answers 404 for a missing product before looking at the colour', async () => {
		const { service, colorRepository } = buildService()
		const productRepository = { findById: jest.fn().mockResolvedValue(null) }
		const scoped = new ProductService(
			productRepository as never,
			{ update: jest.fn() } as never,
			{} as never,
			colorRepository as never
		)

		await expect(
			scoped.updateVariant(PRODUCT_ID, VARIANT_ID, { color_id: COLOR_ID } as never)
		).rejects.toBeInstanceOf(NotFoundException)
		expect(colorRepository.findById).not.toHaveBeenCalled()
	})
})
