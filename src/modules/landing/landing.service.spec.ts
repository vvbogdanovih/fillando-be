import { ConflictException, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { LandingStatus } from 'src/common/types/enums'
import { LandingService } from './landing.service'

const CATEGORY_ID = '000000000000000000000c01'
const LANDING_ID = '000000000000000000000001'

/** Shape of what the service hands the repository — enough to assert on, and typed. */
type WrittenLanding = {
	intro_html?: string
	bottom_html?: string
	h1?: string
	faq?: { q: string; a: string }[]
	category_id?: unknown
}

const written = (mock: jest.Mock, callIndex = 0, argIndex = 0): WrittenLanding => {
	const calls = mock.mock.calls as unknown[][]
	return calls[callIndex][argIndex] as WrittenLanding
}

const buildService = (
	overrides: {
		category?: unknown
		activeLanding?: unknown
		existingSlug?: unknown
		current?: unknown
	} = {}
) => {
	const landingRepository = {
		findActive: jest.fn().mockResolvedValue([]),
		findAllForAdmin: jest.fn().mockResolvedValue([]),
		findActiveSlugs: jest.fn().mockResolvedValue([]),
		findActiveByCategoryAndSlug: jest.fn().mockResolvedValue(overrides.activeLanding ?? null),
		findByCategoryAndSlug: jest.fn().mockResolvedValue(overrides.existingSlug ?? null),
		findById: jest.fn().mockResolvedValue(
			overrides.current ?? {
				_id: LANDING_ID,
				category_id: new Types.ObjectId(CATEGORY_ID),
				slug: 'pla-silk'
			}
		),
		create: jest.fn().mockImplementation((data: unknown) => Promise.resolve(data)),
		update: jest.fn().mockImplementation((_f: unknown, data: unknown) => Promise.resolve(data)),
		delete: jest.fn().mockResolvedValue(true)
	}
	const categoryRepository = {
		findBySlug: jest.fn().mockResolvedValue(overrides.category ?? null),
		findById: jest.fn().mockResolvedValue({ _id: CATEGORY_ID, slug: 'filament' })
	}
	const service = new LandingService(landingRepository as never, categoryRepository as never)
	return { service, landingRepository, categoryRepository }
}

const baseDto = {
	category_id: CATEGORY_ID,
	slug: 'pla-silk',
	h1: 'PLA Silk філамент',
	title: 'PLA Silk — Fillando',
	meta_description: 'PLA Silk філамент'
}

describe('LandingService — public reads never expose drafts', () => {
	it('resolves an address only through the active-only repository method', async () => {
		const category = {
			_id: new Types.ObjectId(CATEGORY_ID),
			slug: 'filament',
			name: 'Філамент'
		}
		const { service, landingRepository } = buildService({
			category,
			activeLanding: {
				toObject: () => ({ slug: 'pla-silk', status: LandingStatus.ACTIVE })
			}
		})

		await service.findActiveBySlugs('filament', 'pla-silk')

		expect(landingRepository.findActiveByCategoryAndSlug).toHaveBeenCalledTimes(1)
		// The unfiltered lookup exists for the admin edit form only; a public request must
		// never reach it, or a draft page would answer 200 (the defect Plan-0003 closed for
		// products).
		expect(landingRepository.findByCategoryAndSlug).not.toHaveBeenCalled()
	})

	it('answers 404 for a draft, exactly as for an unknown slug', async () => {
		const category = {
			_id: new Types.ObjectId(CATEGORY_ID),
			slug: 'filament',
			name: 'Філамент'
		}
		const { service } = buildService({ category, activeLanding: null })

		await expect(service.findActiveBySlugs('filament', 'draft-page')).rejects.toBeInstanceOf(
			NotFoundException
		)
	})

	it('answers 404 for an unknown category without probing the landings', async () => {
		const { service, landingRepository } = buildService({ category: null })

		await expect(service.findActiveBySlugs('nope', 'pla-silk')).rejects.toBeInstanceOf(
			NotFoundException
		)
		expect(landingRepository.findActiveByCategoryAndSlug).not.toHaveBeenCalled()
	})

	it('lists and enumerates slugs through the active-only methods', async () => {
		const { service, landingRepository } = buildService()

		await service.findActive(CATEGORY_ID)
		await service.findActiveSlugs()

		expect(landingRepository.findActive).toHaveBeenCalledWith(CATEGORY_ID)
		expect(landingRepository.findActiveSlugs).toHaveBeenCalledTimes(1)
		expect(landingRepository.findAllForAdmin).not.toHaveBeenCalled()
	})
})

describe('LandingService — copy is sanitized on write', () => {
	it('strips scripts from the rich-text fields on create', async () => {
		const { service, landingRepository } = buildService()

		await service.create({
			...baseDto,
			intro_html: '<p>ok</p><script>alert(1)</script>',
			bottom_html: '<p onclick="x()">text</p>'
		})

		const created = written(landingRepository.create)
		expect(created.intro_html).toBe('<p>ok</p>')
		expect(created.bottom_html).toBe('<p>text</p>')
	})

	it('strips markup from headings and FAQ entries', async () => {
		const { service, landingRepository } = buildService()

		await service.create({
			...baseDto,
			h1: '<b>PLA Silk</b>',
			faq: [{ q: '<i>Питання</i>', a: 'Відповідь<script>x()</script>' }]
		})

		const created = written(landingRepository.create)
		expect(created.h1).toBe('PLA Silk')
		expect(created.faq).toEqual([{ q: 'Питання', a: 'Відповідь' }])
	})

	it('sanitizes on update too', async () => {
		const { service, landingRepository } = buildService()

		await service.update(LANDING_ID, { bottom_html: '<p>a</p><iframe src="x"></iframe>' })

		const patched = written(landingRepository.update, 0, 1)
		expect(patched.bottom_html).toBe('<p>a</p>')
	})

	it('leaves fields the request did not mention untouched', async () => {
		const { service, landingRepository } = buildService()

		await service.update(LANDING_ID, { order: 3 })

		const patched = written(landingRepository.update, 0, 1)
		expect(patched).not.toHaveProperty('intro_html')
		expect(patched).not.toHaveProperty('h1')
	})
})

describe('LandingService — slug uniqueness inside a category', () => {
	it('refuses a slug already taken in the same category', async () => {
		const { service } = buildService({ existingSlug: { _id: 'other' } })

		await expect(service.create(baseDto)).rejects.toBeInstanceOf(ConflictException)
	})

	it('lets a landing keep its own slug on update', async () => {
		const { service, landingRepository } = buildService({
			existingSlug: { _id: LANDING_ID }
		})

		await expect(service.update(LANDING_ID, { slug: 'pla-silk' })).resolves.toBeDefined()
		expect(landingRepository.update).toHaveBeenCalledTimes(1)
	})

	it('stores the ObjectId form of category_id, not the string', async () => {
		const { service, landingRepository } = buildService()

		await service.create(baseDto)

		expect(written(landingRepository.create).category_id).toBeInstanceOf(Types.ObjectId)
	})
})

describe('LandingService — malformed ids', () => {
	it.each([
		['findById', (s: LandingService) => s.findById('nope')],
		['update', (s: LandingService) => s.update('nope', {})],
		['delete', (s: LandingService) => s.delete('nope')]
	])('%s answers 404 without hitting a repository', async (_name, call) => {
		const { service, landingRepository } = buildService()

		await expect(call(service)).rejects.toBeInstanceOf(NotFoundException)
		expect(landingRepository.findById).not.toHaveBeenCalled()
	})
})
