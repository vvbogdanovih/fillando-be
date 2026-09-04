import { ConflictException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { Types } from 'mongoose'
import { ColorFamily } from 'src/common/types/enums'
import { ProductService } from './product.service'
import { UpdateVariantDto } from './dto/update-variant.dto'

/**
 * Three invariants of variant identity, all of which used to break silently.
 *
 * 1. **The name stays Ukrainian.** `normalize-variant-colors.js` wrote `v_value` as the canonical
 *    English dictionary name and `name` as `"<product> — <name_uk>"` (TD-0002 §5.2.2). The service
 *    rebuilt `name` from `v_value`, so the first ordinary save — changing a price, fixing a
 *    description — renamed the variant to English. Nothing errored; the catalogue listing, the
 *    `ItemList` markup and the cart rows just drifted into two languages, one product at a time.
 *
 * 2. **A rename never half-applies.** Slugs are unique and a rename regenerates all of a product's
 *    at once. With no transaction available (standalone MongoDB), a duplicate discovered mid-batch
 *    left the product renamed and only some variants rewritten. Two shapes have to be handled: a
 *    genuine clash, refused up front, and a *rotation*, where the address one variant is moving to
 *    is still held by a sibling that is itself moving.
 *
 * 3. **A partial PATCH means only what it says.** `target: ES2023` gives every declared DTO field
 *    an own property, so `'field' in dto` is true for fields the client never sent.
 */
const PRODUCT_ID = '000000000000000000000001'
const VARIANT_ID = '000000000000000000000002'
const COLOR_ID = '000000000000000000000003'
const CATEGORY_ID = '000000000000000000000c01'
const PRODUCT_NAME = 'PLA Basic'

const BLACK = {
	_id: new Types.ObjectId(COLOR_ID),
	family: ColorFamily.BLACK,
	name_uk: 'Чорний',
	name_en: 'Black'
}

const buildService = (
	overrides: {
		variants?: Record<string, unknown>[]
		slugsTaken?: Record<string, unknown>[]
		existingVariant?: Record<string, unknown> | null
	} = {}
) => {
	const productRepository = {
		findById: jest.fn().mockResolvedValue({
			_id: new Types.ObjectId(PRODUCT_ID),
			name: PRODUCT_NAME,
			category_id: new Types.ObjectId(CATEGORY_ID)
		}),
		update: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(PRODUCT_ID) }),
		create: jest.fn().mockResolvedValue({
			_id: new Types.ObjectId(PRODUCT_ID),
			name: PRODUCT_NAME,
			category_id: new Types.ObjectId(CATEGORY_ID),
			toObject: () => ({ _id: new Types.ObjectId(PRODUCT_ID), name: PRODUCT_NAME })
		})
	}
	const productVariantRepository = {
		create: jest
			.fn()
			.mockImplementation((data: Record<string, unknown>) =>
				Promise.resolve({ ...data, toObject: () => data })
			),
		update: jest.fn().mockImplementation((_f: unknown, data: unknown) => Promise.resolve(data)),
		// `updateVariant` reads the variant first: a request that omits `color_id` still needs the
		// colour already stored on it to rebuild the display name.
		findOne: jest
			.fn()
			.mockResolvedValue(
				overrides.existingVariant === undefined
					? { _id: new Types.ObjectId(VARIANT_ID), v_value: 'Black', color_id: BLACK._id }
					: overrides.existingVariant
			),
		findByProductId: jest.fn().mockResolvedValue(overrides.variants ?? []),
		findBySlugs: jest.fn().mockResolvedValue(overrides.slugsTaken ?? []),
		updateCategoryByProductId: jest.fn().mockResolvedValue(undefined)
	}
	const numbersRepository = { increment: jest.fn().mockResolvedValue(42) }
	const colorRepository = {
		findById: jest.fn().mockResolvedValue(BLACK),
		findByIds: jest.fn().mockResolvedValue([BLACK])
	}
	const service = new ProductService(
		productRepository as never,
		productVariantRepository as never,
		numbersRepository as never,
		colorRepository as never
	)
	return { service, productRepository, productVariantRepository, colorRepository }
}

/** A stored variant on the colour axis, as the migration left it. */
const migratedVariant = (over: Record<string, unknown> = {}) => ({
	_id: new Types.ObjectId(VARIANT_ID),
	sku: 'FL-000001',
	v_value: 'Black',
	slug: 'pla-basic-black',
	color_id: BLACK._id,
	...over
})

/** The patch of the last write to a variant — after a rename that is the final identity. */
const lastPatch = (repo: { update: jest.Mock }) =>
	repo.update.mock.calls[repo.update.mock.calls.length - 1][1] as Record<string, unknown>

describe('variant name — the dictionary spelling wins over v_value', () => {
	it('create names the variant in Ukrainian while the slug stays English', async () => {
		const { service, productVariantRepository } = buildService()

		await service.create({
			name: PRODUCT_NAME,
			category_id: CATEGORY_ID,
			vendor_id: CATEGORY_ID,
			variants: [{ price: 100, v_value: 'Black', color_id: COLOR_ID }]
		})

		const written = productVariantRepository.create.mock.calls[0][0] as Record<string, unknown>
		expect(written.name).toBe('PLA Basic — Чорний')
		expect(written.slug).toBe('pla-basic-black')
	})

	it('addVariant does the same', async () => {
		const { service, productVariantRepository } = buildService()

		await service.addVariant(PRODUCT_ID, {
			price: 100,
			v_value: 'Black',
			color_id: COLOR_ID
		})

		const written = productVariantRepository.create.mock.calls[0][0] as Record<string, unknown>
		expect(written.name).toBe('PLA Basic — Чорний')
		expect(written.slug).toBe('pla-basic-black')
	})

	it('updateVariant rebuilds the name from the colour already stored when the request omits it', async () => {
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { v_value: 'Black' })

		expect(lastPatch(productVariantRepository).name).toBe('PLA Basic — Чорний')
	})

	it('changing only the colour still relabels the variant', async () => {
		// The name is derived from the dictionary now, so a colour swap that leaves `v_value` alone
		// would otherwise keep advertising the previous colour.
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { color_id: COLOR_ID })

		expect(lastPatch(productVariantRepository).name).toBe('PLA Basic — Чорний')
	})

	it('falls back to v_value when the variant carries no colour', async () => {
		const { service, productVariantRepository } = buildService({
			existingVariant: {
				_id: new Types.ObjectId(VARIANT_ID),
				v_value: 'Candy',
				color_id: null
			}
		})

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, { v_value: 'Candy' })

		expect(lastPatch(productVariantRepository).name).toBe('PLA Basic — Candy')
	})

	it('clearing the colour drops back to v_value rather than keeping the old label', async () => {
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, {
			v_value: 'Black',
			color_id: null
		})

		expect(lastPatch(productVariantRepository).name).toBe('PLA Basic — Black')
	})

	it('a blank name_uk in the dictionary does not swallow the suffix', async () => {
		const { service, productVariantRepository, colorRepository } = buildService()
		colorRepository.findById.mockResolvedValue({ ...BLACK, name_uk: '   ' })

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, {
			v_value: 'Black',
			color_id: COLOR_ID
		})

		expect(lastPatch(productVariantRepository).name).toBe('PLA Basic — Black')
	})

	it('a rename relabels every variant in Ukrainian', async () => {
		const { service, productVariantRepository } = buildService({
			variants: [migratedVariant()]
		})

		await service.update(PRODUCT_ID, { name: 'PLA Basic v2' })

		const patch = lastPatch(productVariantRepository)
		expect(patch.name).toBe('PLA Basic v2 — Чорний')
		expect(patch.slug).toBe('pla-basic-v2-black')
	})
})

describe('a partial PATCH means only what it says', () => {
	// Built through class-transformer the way the global ValidationPipe does, because that is what
	// creates the trap: the compiled DTO declares every field, so `'v_value' in dto` is true even
	// for a body that only mentions stock. A plain object literal would not reproduce it, and a
	// test written that way passes against the old code too — guarding nothing.
	const partialPatch = (body: Record<string, unknown>) => plainToInstance(UpdateVariantDto, body)

	it('the trap is real — the DTO carries fields the client never sent', () => {
		const dto = partialPatch({ stock: 7 })

		expect('v_value' in dto).toBe(true)
		expect(dto.v_value).toBeUndefined()
	})

	it('an edit that only touches stock rewrites neither name nor slug', async () => {
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, partialPatch({ stock: 7 }))

		// The spread of the DTO carries `name`/`slug` as own properties with no value — Mongoose
		// drops those. What matters is that neither was *given* one: the old code put the bare
		// product name and its slug here, which is how the variant lost its own address.
		const patch = lastPatch(productVariantRepository)
		expect(patch.name).toBeUndefined()
		expect(patch.slug).toBeUndefined()
	})

	it('freshness dates are stamped only for the field that actually moved', async () => {
		// Both are public — `stock_updated_at` is the price sheet's "synced" column — so stamping
		// them on an unrelated edit tells shoppers the stock was just checked when it was not.
		const { service, productVariantRepository } = buildService()

		await service.updateVariant(PRODUCT_ID, VARIANT_ID, partialPatch({ stock: 7 }))

		const patch = lastPatch(productVariantRepository)
		expect(patch.stock_updated_at).toBeInstanceOf(Date)
		expect(patch).not.toHaveProperty('price_updated_at')
	})
})

describe('a rename that would collide is refused before anything is written', () => {
	it('two variants heading for one address → 409 naming both SKUs', async () => {
		// The real pair: two 'Candy' variants imported from Prom onto one product, one of which
		// never got the suffix. Regenerating would send both to the same slug.
		const { service, productRepository, productVariantRepository } = buildService({
			variants: [
				migratedVariant({
					_id: new Types.ObjectId('00000000000000000000000a'),
					sku: 'FL-000157',
					v_value: 'Candy',
					slug: 'silk-rainbow-candy',
					color_id: null
				}),
				migratedVariant({
					_id: new Types.ObjectId('00000000000000000000000b'),
					sku: 'FL-000162',
					v_value: 'Candy',
					slug: 'silk-rainbow',
					color_id: null
				})
			]
		})

		const attempt = service.update(PRODUCT_ID, { name: 'Silk Rainbow' })

		await expect(attempt).rejects.toBeInstanceOf(ConflictException)
		await expect(attempt).rejects.toThrow(/FL-000157 \+ FL-000162/)
		expect(productRepository.update).not.toHaveBeenCalled()
		expect(productVariantRepository.update).not.toHaveBeenCalled()
	})

	it('an address owned by another product → 409, still nothing written', async () => {
		const { service, productRepository, productVariantRepository } = buildService({
			variants: [migratedVariant()],
			slugsTaken: [
				{
					_id: new Types.ObjectId('00000000000000000000000c'),
					sku: 'FL-000999',
					slug: 'pla-basic-v2-black'
				}
			]
		})

		await expect(service.update(PRODUCT_ID, { name: 'PLA Basic v2' })).rejects.toBeInstanceOf(
			ConflictException
		)
		expect(productRepository.update).not.toHaveBeenCalled()
		expect(productVariantRepository.update).not.toHaveBeenCalled()
	})

	it('a variant of this product holding the address is not a conflict — it moves too', async () => {
		// Rotation: renaming "PLA" to "PLA Black" sends the plain variant to `pla-black`, which its
		// sibling is still sitting on. One pass would race; the two-pass write parks the movers on
		// temporary addresses first, so neither write hits the unique index.
		const plain = migratedVariant({
			_id: new Types.ObjectId('00000000000000000000000a'),
			sku: 'FL-000031',
			v_value: null,
			slug: 'pla',
			color_id: null
		})
		const black = migratedVariant({
			_id: new Types.ObjectId('00000000000000000000000b'),
			sku: 'FL-000048',
			v_value: 'Black',
			slug: 'pla-black',
			color_id: null
		})
		const { service, productVariantRepository } = buildService({
			variants: [plain, black],
			slugsTaken: [
				{ _id: plain._id, sku: plain.sku, slug: 'pla' },
				{ _id: black._id, sku: black.sku, slug: 'pla-black' }
			]
		})

		await service.update(PRODUCT_ID, { name: 'PLA Black' })

		const slugs = productVariantRepository.update.mock.calls.map(
			c => (c[1] as { slug: string }).slug
		)
		// Both variants move, so both must be parked — and every park has to land before the first
		// variant claims its target, or the one still holding it loses the race to the unique index.
		const parks = slugs.filter(s => s.includes('-moving-'))
		expect(parks).toHaveLength(2)
		const firstFinal = slugs.findIndex(s => !s.includes('-moving-'))
		const lastPark = slugs.map(s => s.includes('-moving-')).lastIndexOf(true)
		expect(lastPark).toBeLessThan(firstFinal)
		expect(slugs.slice(firstFinal)).toEqual(['pla-black', 'pla-black-black'])
	})

	it('saving a product without changing its name leaves the variants untouched', async () => {
		// The admin form posts `name` on every save. Treating that as a rename re-planned — and
		// re-rejected — edits that had nothing to do with the name.
		const { service, productVariantRepository } = buildService({
			variants: [migratedVariant()]
		})

		await service.update(PRODUCT_ID, { name: PRODUCT_NAME, vendor_id: CATEGORY_ID })

		expect(productVariantRepository.findByProductId).not.toHaveBeenCalled()
		expect(productVariantRepository.update).not.toHaveBeenCalled()
	})

	it('an edit that does not mention the name never runs the check', async () => {
		const { service, productVariantRepository } = buildService()

		await service.update(PRODUCT_ID, { vendor_id: CATEGORY_ID })

		expect(productVariantRepository.findByProductId).not.toHaveBeenCalled()
		expect(productVariantRepository.findBySlugs).not.toHaveBeenCalled()
	})
})
