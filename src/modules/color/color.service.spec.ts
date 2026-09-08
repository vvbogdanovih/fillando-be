import { ConflictException, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ColorFamily } from 'src/common/types/enums'
import { ColorService } from './color.service'

const GOOD_ID = '000000000000000000000001'
const BAD_ID = 'not-an-object-id'

const buildService = (
	overrides: {
		color?: unknown
		inUse?: number
		dictionary?: unknown[]
		usage?: Map<string, number>
		nameSources?: unknown[]
	} = {}
) => {
	const updated = overrides.color ?? {
		_id: GOOD_ID,
		name_en: 'Bambu Green',
		family: ColorFamily.GREEN
	}
	const colorRepository = {
		findAllOrdered: jest.fn().mockResolvedValue(overrides.dictionary ?? []),
		findById: jest.fn().mockResolvedValue(updated),
		create: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
		update: jest.fn().mockResolvedValue(updated),
		delete: jest.fn().mockResolvedValue(true)
	}
	const productVariantRepository = {
		updateColorFamilyByColorId: jest.fn().mockResolvedValue(3),
		countByColorId: jest.fn().mockResolvedValue(overrides.inUse ?? 0),
		countAllByColorId: jest.fn().mockResolvedValue(overrides.usage ?? new Map()),
		findNameSourcesByColorId: jest.fn().mockResolvedValue(overrides.nameSources ?? []),
		renameVariants: jest
			.fn()
			.mockImplementation((renames: unknown[]) => Promise.resolve(renames.length))
	}
	const revalidation = { revalidate: jest.fn() }
	const service = new ColorService(
		colorRepository as never,
		productVariantRepository as never,
		revalidation as never
	)
	return { service, colorRepository, productVariantRepository, revalidation }
}

describe('ColorService.create', () => {
	it('derives the slug from the English name when none is given', async () => {
		const { service, colorRepository } = buildService()

		await service.create({
			name_en: 'Bambu Green',
			name_uk: 'Зелений Bambu',
			family: ColorFamily.GREEN,
			hex_stops: ['#2F855A']
		})

		expect(colorRepository.create).toHaveBeenCalledWith(
			expect.objectContaining({ slug: 'bambu-green' })
		)
	})

	it('keeps an explicit slug', async () => {
		const { service, colorRepository } = buildService()

		await service.create({
			name_en: 'Bambu Green',
			name_uk: 'Зелений Bambu',
			slug: 'green-bambu',
			family: ColorFamily.GREEN,
			hex_stops: ['#2F855A']
		})

		expect(colorRepository.create).toHaveBeenCalledWith(
			expect.objectContaining({ slug: 'green-bambu' })
		)
	})

	it('stores hex stops in one casing so diffs and lookups are predictable', async () => {
		const { service, colorRepository } = buildService()

		await service.create({
			name_en: 'Gold',
			name_uk: 'Золотий',
			family: ColorFamily.GOLD,
			hex_stops: ['#D4AF37', '#FFF3B0']
		})

		expect(colorRepository.create).toHaveBeenCalledWith(
			expect.objectContaining({ hex_stops: ['#d4af37', '#fff3b0'] })
		)
	})
})

describe('ColorService.update — denormalized color_family', () => {
	/**
	 * TD-0002 §5.2.2 asked for one transaction; this deployment runs a standalone MongoDB and
	 * cannot give one. The order is the compensation: the dictionary (source of truth) is
	 * written first, so a failed backfill leaves variants recomputable from it.
	 */
	it('writes the dictionary before backfilling the variants', async () => {
		const { service, colorRepository, productVariantRepository } = buildService()
		const calls: string[] = []
		colorRepository.update.mockImplementation(() => {
			calls.push('dictionary')
			return Promise.resolve({ _id: GOOD_ID, name_en: 'X', family: ColorFamily.RED })
		})
		productVariantRepository.updateColorFamilyByColorId.mockImplementation(() => {
			calls.push('variants')
			return Promise.resolve(2)
		})

		await service.update(GOOD_ID, { family: ColorFamily.RED })

		expect(calls).toEqual(['dictionary', 'variants'])
	})

	it('backfills with the family the dictionary now holds, not the one the caller sent', async () => {
		const { service, colorRepository, productVariantRepository } = buildService()
		colorRepository.update.mockResolvedValue({
			_id: GOOD_ID,
			name_en: 'X',
			family: ColorFamily.BLUE
		})

		await service.update(GOOD_ID, { name_uk: 'Синій' })

		expect(productVariantRepository.updateColorFamilyByColorId).toHaveBeenCalledWith(
			GOOD_ID,
			ColorFamily.BLUE
		)
	})

	it('runs the backfill even when family was not part of the request, so a retry repairs drift', async () => {
		const { service, productVariantRepository } = buildService()

		await service.update(GOOD_ID, { order: 5 })

		expect(productVariantRepository.updateColorFamilyByColorId).toHaveBeenCalledTimes(1)
	})

	it('fails the request when the backfill fails, rather than reporting a half-done change', async () => {
		const { service, productVariantRepository } = buildService()
		productVariantRepository.updateColorFamilyByColorId.mockRejectedValue(new Error('down'))

		await expect(service.update(GOOD_ID, { family: ColorFamily.RED })).rejects.toThrow('down')
	})

	it('never touches the variants when the colour does not exist', async () => {
		const { service, colorRepository, productVariantRepository } = buildService()
		colorRepository.update.mockResolvedValue(null)

		await expect(service.update(GOOD_ID, { family: ColorFamily.RED })).rejects.toBeInstanceOf(
			NotFoundException
		)
		expect(productVariantRepository.updateColorFamilyByColorId).not.toHaveBeenCalled()
	})
})

/**
 * I-f: an admin fixing a colour spelling has to reach the *stored* variant names.
 *
 * `variantName`/`variantLabel` prefer the dictionary, so the product page showed the new
 * spelling at once — while the catalogue card, the cart row, the price sheet and every order
 * snapshot still read the old one, because those are the stored `ProductVariant.name`. The
 * shopper saw two names for one colour, and the only repair was re-saving every product.
 */
describe('ColorService.update — stored variant names (I-f)', () => {
	const VARIANT_A = new Types.ObjectId('000000000000000000000021')
	const VARIANT_B = new Types.ObjectId('000000000000000000000022')

	/** A stored variant as the join returns it: its current name plus what rebuilds it. */
	const source = (over: Record<string, unknown> = {}) => ({
		_id: VARIANT_A,
		name: 'PLA Basic — Чорний (Black)',
		v_value: 'Black',
		product_name: 'PLA Basic',
		...over
	})

	const dictionary = (over: Record<string, unknown> = {}) => ({
		_id: GOOD_ID,
		name_uk: 'Чорний',
		name_en: 'Black',
		family: ColorFamily.BLACK,
		...over
	})

	type Rename = { id: Types.ObjectId; name: string }

	/** What the backfill actually asked the repository to write. */
	const written = (repo: { renameVariants: jest.Mock }): Rename[] => {
		const calls = repo.renameVariants.mock.calls as Array<[Rename[]]>
		return calls[0][0]
	}

	it('a new Ukrainian name reaches the stored variant names', async () => {
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [source()]
		})
		colorRepository.update.mockResolvedValue(dictionary({ name_uk: 'Вугільний' }))

		await service.update(GOOD_ID, { name_uk: 'Вугільний' })

		expect(written(productVariantRepository)).toEqual([
			{ id: VARIANT_A, name: 'PLA Basic — Вугільний (Black)' }
		])
	})

	it('a new English name reaches the bracketed half', async () => {
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [source()]
		})
		colorRepository.update.mockResolvedValue(dictionary({ name_en: 'Carbon' }))

		await service.update(GOOD_ID, { name_en: 'Carbon' })

		expect(written(productVariantRepository)).toEqual([
			{ id: VARIANT_A, name: 'PLA Basic — Чорний (Carbon)' }
		])
	})

	it("uses ProductService's own rule, collapsing a pair that is one word", async () => {
		// «Candy (Candy)» would be the literal reading of the format and is nobody's idea of a
		// name. Restating the rule here instead of importing it is how the catalogue card and
		// the product page ended up in two languages in the first place.
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [source({ name: 'PLA Basic — Чорний (Black)', v_value: 'Candy' })]
		})
		colorRepository.update.mockResolvedValue(dictionary({ name_uk: 'Candy', name_en: 'Candy' }))

		await service.update(GOOD_ID, { name_uk: 'Candy' })

		expect(written(productVariantRepository)[0].name).toBe('PLA Basic — Candy')
	})

	it('never writes v_value or the slug — addresses stay where Google found them', async () => {
		// `v_value` holds the canonical English spelling and the slug is generated from it, so a
		// dictionary rename must not move a single URL. `v_value` disagreeing with `name_en` is
		// the design (TD-0002 §5.2.2), not drift for a later reader to "fix".
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [source()]
		})
		colorRepository.update.mockResolvedValue(dictionary({ name_uk: 'Вугільний' }))

		await service.update(GOOD_ID, { name_uk: 'Вугільний' })

		for (const rename of written(productVariantRepository)) {
			expect(Object.keys(rename).sort()).toEqual(['id', 'name'])
		}
	})

	it('a PATCH that changes no name writes nothing at all', async () => {
		// Reordering the dictionary or fixing a hex stop must not touch a single variant: there
		// is no transaction here, so the write has to be filtered on drift to stay idempotent.
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [source()]
		})
		colorRepository.update.mockResolvedValue(dictionary())

		await service.update(GOOD_ID, { order: 5 })

		expect(written(productVariantRepository)).toEqual([])
	})

	it('skips the variants already carrying the right name', async () => {
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [
				source({ name: 'PLA Basic — Вугільний (Black)' }),
				source({ _id: VARIANT_B, name: 'PETG — Чорний (Black)', product_name: 'PETG' })
			]
		})
		colorRepository.update.mockResolvedValue(dictionary({ name_uk: 'Вугільний' }))

		await service.update(GOOD_ID, { name_uk: 'Вугільний' })

		expect(written(productVariantRepository)).toEqual([
			{ id: VARIANT_B, name: 'PETG — Вугільний (Black)' }
		])
	})

	it('reads the product names in one pass, not one query per variant', async () => {
		const { service, productVariantRepository } = buildService({
			nameSources: [source(), source({ _id: VARIANT_B, product_name: 'PETG' })]
		})

		await service.update(GOOD_ID, { name_uk: 'Вугільний' })

		expect(productVariantRepository.findNameSourcesByColorId).toHaveBeenCalledTimes(1)
		expect(productVariantRepository.renameVariants).toHaveBeenCalledTimes(1)
	})

	it('writes the dictionary first, then the derived fields', async () => {
		// The order is the compensation for the missing transaction, so it is asserted rather
		// than left to the reading order of the method.
		const { service, colorRepository, productVariantRepository } = buildService({
			nameSources: [source()]
		})
		const calls: string[] = []
		colorRepository.update.mockImplementation(() => {
			calls.push('dictionary')
			return Promise.resolve(dictionary({ name_uk: 'Вугільний' }))
		})
		productVariantRepository.updateColorFamilyByColorId.mockImplementation(() => {
			calls.push('family')
			return Promise.resolve(1)
		})
		productVariantRepository.renameVariants.mockImplementation(() => {
			calls.push('names')
			return Promise.resolve(1)
		})

		await service.update(GOOD_ID, { name_uk: 'Вугільний' })

		expect(calls).toEqual(['dictionary', 'family', 'names'])
	})

	it('fails the request when the rename fails, so a retry can repair it', async () => {
		const { service, productVariantRepository, revalidation } = buildService({
			nameSources: [source()]
		})
		productVariantRepository.renameVariants.mockRejectedValue(new Error('down'))

		await expect(service.update(GOOD_ID, { name_uk: 'Вугільний' })).rejects.toThrow('down')
		expect(revalidation.revalidate).not.toHaveBeenCalled()
	})

	it('never touches the variant names when the colour does not exist', async () => {
		const { service, colorRepository, productVariantRepository } = buildService()
		colorRepository.update.mockResolvedValue(null)

		await expect(service.update(GOOD_ID, { name_uk: 'Вугільний' })).rejects.toBeInstanceOf(
			NotFoundException
		)
		expect(productVariantRepository.findNameSourcesByColorId).not.toHaveBeenCalled()
		expect(productVariantRepository.renameVariants).not.toHaveBeenCalled()
	})

	it('purges the storefront once — the colour is on every catalogue card', async () => {
		const { service, revalidation } = buildService({ nameSources: [source()] })

		await service.update(GOOD_ID, { name_uk: 'Вугільний' })

		expect(revalidation.revalidate).toHaveBeenCalledTimes(1)
		expect(revalidation.revalidate).toHaveBeenCalledWith('products', expect.any(String))
	})
})

describe('ColorService.delete', () => {
	it('refuses while variants still point at the colour', async () => {
		const { service, colorRepository } = buildService({ inUse: 4 })

		await expect(service.delete(GOOD_ID)).rejects.toBeInstanceOf(ConflictException)
		expect(colorRepository.delete).not.toHaveBeenCalled()
	})

	it('deletes an unused colour', async () => {
		const { service, colorRepository } = buildService({ inUse: 0 })

		await expect(service.delete(GOOD_ID)).resolves.toEqual({ success: true })
		expect(colorRepository.delete).toHaveBeenCalledTimes(1)
	})
})

describe('ColorService — malformed ids', () => {
	it.each([
		['findById', (s: ColorService) => s.findById(BAD_ID)],
		['update', (s: ColorService) => s.update(BAD_ID, {})],
		['delete', (s: ColorService) => s.delete(BAD_ID)]
	])('%s answers 404 without hitting a repository', async (_name, call) => {
		const { service, colorRepository, productVariantRepository } = buildService()

		await expect(call(service)).rejects.toBeInstanceOf(NotFoundException)

		expect(colorRepository.findById).not.toHaveBeenCalled()
		expect(colorRepository.update).not.toHaveBeenCalled()
		expect(colorRepository.delete).not.toHaveBeenCalled()
		expect(productVariantRepository.countByColorId).not.toHaveBeenCalled()
	})
})

describe('ColorService.findAllForAdmin — the "Варіантів" column (Plan-0005 D2)', () => {
	const BLACK = '000000000000000000000011'
	const GOLD = '000000000000000000000012'
	const dictionary = [
		{ _id: BLACK, name_en: 'Black', order: 10 },
		{ _id: GOLD, name_en: 'Gold Silk', order: 20 }
	]

	it('carries the usage count of every dictionary row', async () => {
		const { service } = buildService({
			dictionary,
			usage: new Map([
				[BLACK, 34],
				[GOLD, 9]
			])
		})

		await expect(service.findAllForAdmin()).resolves.toEqual([
			expect.objectContaining({ name_en: 'Black', variant_count: 34 }),
			expect.objectContaining({ name_en: 'Gold Silk', variant_count: 9 })
		])
	})

	/**
	 * A seeded colour no variant matched is the whole point of the column: it is what tells the
	 * admin which spellings are still unresolved. It has to read 0, not vanish and not be
	 * `undefined`.
	 */
	it('reads 0 for a colour nothing points at', async () => {
		const { service } = buildService({ dictionary, usage: new Map([[BLACK, 34]]) })

		const rows = await service.findAllForAdmin()

		expect(rows.find(row => row.name_en === 'Gold Silk')?.variant_count).toBe(0)
	})

	it('counts in one grouped query rather than one per colour', async () => {
		const { service, productVariantRepository } = buildService({ dictionary })

		await service.findAllForAdmin()

		expect(productVariantRepository.countAllByColorId).toHaveBeenCalledTimes(1)
		expect(productVariantRepository.countByColorId).not.toHaveBeenCalled()
	})

	/** The public dictionary must not start paying for the aggregation. */
	it('leaves the public listing untouched', async () => {
		const { service, productVariantRepository } = buildService({ dictionary })

		const rows = await service.findAll()

		expect(rows).toEqual(dictionary)
		expect(productVariantRepository.countAllByColorId).not.toHaveBeenCalled()
	})
})
