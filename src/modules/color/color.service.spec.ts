import { ConflictException, NotFoundException } from '@nestjs/common'
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
		countAllByColorId: jest.fn().mockResolvedValue(overrides.usage ?? new Map())
	}
	const service = new ColorService(colorRepository as never, productVariantRepository as never)
	return { service, colorRepository, productVariantRepository }
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
