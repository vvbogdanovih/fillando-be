import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { sanitizePlainText, sanitizeRichText } from 'src/common/utils'
import { CreateLandingDto } from './dto/create-landing.dto'
import { UpdateLandingDto } from './dto/update-landing.dto'

@Injectable()
export class LandingService {
	constructor(
		private readonly landingRepository: LandingRepository,
		private readonly categoryRepository: CategoryRepository
	) {}

	/** PUBLIC — active landings only. */
	findActive(categoryId?: string) {
		if (categoryId) this.assertObjectId(categoryId)
		return this.landingRepository.findActive(categoryId)
	}

	/** PUBLIC — the sitemap's source of landing URLs; active only. */
	findActiveSlugs() {
		return this.landingRepository.findActiveSlugs()
	}

	/** ADMIN — drafts included. */
	findAllForAdmin(categoryId?: string) {
		if (categoryId) this.assertObjectId(categoryId)
		return this.landingRepository.findAllForAdmin(categoryId)
	}

	/**
	 * PUBLIC — resolves `/{categorySlug}/{landingSlug}`. An unknown category, an unknown slug
	 * and a draft are all the same 404, so the storefront renders `notFound()` and never leaks
	 * that an unpublished page exists at that address.
	 */
	async findActiveBySlugs(categorySlug: string, landingSlug: string) {
		const category = await this.categoryRepository.findBySlug(categorySlug)
		if (!category) throw new NotFoundException('Landing not found')

		const landing = await this.landingRepository.findActiveByCategoryAndSlug(
			category._id,
			landingSlug
		)
		if (!landing) throw new NotFoundException('Landing not found')

		return {
			...landing.toObject(),
			category_slug: category.slug,
			category_name: category.name
		}
	}

	/** ADMIN — the edit form needs drafts. */
	async findById(id: string) {
		this.assertObjectId(id)
		const landing = await this.landingRepository.findById(id)
		if (!landing) throw new NotFoundException('Landing not found')
		return landing
	}

	async create(dto: CreateLandingDto) {
		await this.assertCategoryExists(dto.category_id)
		const slug = dto.slug.trim()
		await this.assertSlugFree(dto.category_id, slug)

		return this.landingRepository.create({
			...sanitizeLandingCopy(dto),
			slug,
			category_id: new Types.ObjectId(dto.category_id)
		})
	}

	async update(id: string, dto: UpdateLandingDto) {
		this.assertObjectId(id)
		const current = await this.landingRepository.findById(id)
		if (!current) throw new NotFoundException('Landing not found')

		if (dto.category_id) await this.assertCategoryExists(dto.category_id)

		const categoryId = dto.category_id ?? String(current.category_id)
		const slug = dto.slug?.trim() ?? current.slug
		if (slug !== current.slug || categoryId !== String(current.category_id)) {
			await this.assertSlugFree(categoryId, slug, id)
		}

		const updated = await this.landingRepository.update(
			{ _id: id },
			{
				...sanitizeLandingCopy(dto),
				...(dto.slug !== undefined && { slug }),
				...(dto.category_id && { category_id: new Types.ObjectId(dto.category_id) })
			}
		)
		if (!updated) throw new NotFoundException('Landing not found')
		return updated
	}

	async delete(id: string) {
		this.assertObjectId(id)
		const deleted = await this.landingRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Landing not found')
		return { success: true }
	}

	private async assertCategoryExists(categoryId: string): Promise<void> {
		this.assertObjectId(categoryId, 'Category not found')
		const category = await this.categoryRepository.findById(categoryId)
		if (!category) throw new NotFoundException('Category not found')
	}

	/**
	 * The schema's unique index on `{ category_id, slug }` is the real guarantee; this check
	 * exists so the admin gets a readable 409 instead of a driver duplicate-key error.
	 */
	private async assertSlugFree(
		categoryId: string,
		slug: string,
		exceptId?: string
	): Promise<void> {
		const existing = await this.landingRepository.findByCategoryAndSlug(
			new Types.ObjectId(categoryId),
			slug
		)
		if (existing && String(existing._id) !== exceptId) {
			throw new ConflictException(`Landing "${slug}" already exists in this category`)
		}
	}

	private assertObjectId(id: string, message = 'Landing not found'): void {
		if (!Types.ObjectId.isValid(id)) throw new NotFoundException(message)
	}
}

/**
 * Landing copy is admin-authored HTML rendered straight into the page, so every rich-text
 * field is sanitized on write rather than on read — the stored value is the one the sitemap,
 * the feed and any future consumer will reuse. FAQ entries carry no markup at all.
 */
function sanitizeLandingCopy<T extends CreateLandingDto | UpdateLandingDto>(dto: T): T {
	return {
		...dto,
		...(dto.intro_html !== undefined && { intro_html: sanitizeRichText(dto.intro_html) }),
		...(dto.bottom_html !== undefined && { bottom_html: sanitizeRichText(dto.bottom_html) }),
		...(dto.h1 !== undefined && { h1: sanitizePlainText(dto.h1) }),
		...(dto.title !== undefined && { title: sanitizePlainText(dto.title) }),
		...(dto.meta_description !== undefined && {
			meta_description: sanitizePlainText(dto.meta_description)
		}),
		...(dto.faq !== undefined && {
			faq: dto.faq?.map(item => ({
				q: sanitizePlainText(item.q),
				a: sanitizePlainText(item.a)
			}))
		})
	}
}
