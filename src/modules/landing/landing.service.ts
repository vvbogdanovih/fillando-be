import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { Types } from 'mongoose'
import {
	StorefrontRevalidationService,
	storefrontRevalidation
} from 'src/common/services/storefront-revalidation.service'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { LandingRepository } from 'src/database/mongoose/repositories/landing.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { sanitizePlainText, sanitizeRichText } from 'src/common/utils'
import { LandingStatus } from 'src/common/types/enums'
import { CreateLandingDto } from './dto/create-landing.dto'
import { UpdateLandingDto } from './dto/update-landing.dto'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { PublicCatalogService } from '../product/public-catalog.service'

@Injectable()
export class LandingService {
	constructor(
		private readonly landingRepository: LandingRepository,
		private readonly categoryRepository: CategoryRepository,
		private readonly productVariantRepository: ProductVariantRepository,
		/**
		 * The same process-wide instance the product, category and colour services use, so a
		 * landing saved during a bulk write shares its throttle window (Plan-0005 I-h).
		 */
		@Optional()
		private readonly revalidation: StorefrontRevalidationService = storefrontRevalidation,
		/**
		 * Public visibility across the catalogue transition (TD-0013). Optional for the unit
		 * specs, which keep the pre-tree behaviour.
		 */
		@Optional() private readonly publicCategories?: CategoryPublicReadService,
		/** Typed landing counts (Plan-0010 F07); optional for the pre-tree unit specs. */
		@Optional() private readonly typedCatalog?: PublicCatalogService
	) {}

	/**
	 * `product_count` of each landing: a typed landing (`contract_version: 2`) counts its
	 * `filters_v2` with the conditions of `GET /products/catalog/v2`, so a landing created in the
	 * new admin (no legacy `filters`) does not count its whole category; legacy landings as before.
	 */
	private async landingCounts(
		landings: {
			_id: unknown
			category_id: Types.ObjectId
			filters: Record<string, string[]>
			filters_v2?: unknown
			contract_version?: unknown
		}[]
	) {
		const typed = this.typedCatalog
			? landings.filter(row => row.contract_version === 2 && row.filters_v2 != null)
			: []
		const counts = await this.productVariantRepository.countVariantsForLandings(
			landings
				.filter(row => !typed.includes(row))
				.map(landing => ({
					id: String(landing._id),
					category_id: landing.category_id,
					filters: landing.filters
				}))
		)
		const byCategory = new Map<string, typeof typed>()
		for (const row of typed)
			byCategory.set(String(row.category_id), [
				...(byCategory.get(String(row.category_id)) ?? []),
				row
			])
		for (const [categoryId, rows] of byCategory) {
			const typedCounts = await this.typedCatalog!.countTypedLandings(
				categoryId,
				rows.map(row => ({ id: String(row._id), filters: row.filters_v2 }))
			)
			for (const [id, count] of typedCounts) counts.set(id, count)
		}
		return counts
	}

	/** Visible product categories by id, or `null` when visibility is not wired (specs). */
	private async publicLandingCategories() {
		if (!this.publicCategories) return null
		const rows = await this.publicCategories.productCategories()
		return new Map(
			rows.map(row => [
				row._id,
				{ slug: row.slug, name: row.name, version: row.attribute_contract_version }
			])
		)
	}

	/**
	 * A landing is public under a public category of its own contract: a v1 category with its
	 * legacy `filters`, a v2 category only once the landing carries typed `filters_v2`
	 * (`contract_version: 2`) — a v2 page never reinterprets legacy pins.
	 */
	private static landingFits(
		landing: { contract_version?: unknown; filters_v2?: unknown },
		version: number | undefined
	) {
		if (version === 1) return true
		return version === 2 && landing.contract_version === 2 && landing.filters_v2 != null
	}

	/**
	 * PUBLIC — active landings only, each with `product_count`.
	 *
	 * The count is on the public listing because the category page's «Популярні види» tiles show
	 * it («64 товари»), and it is not private information: the same number is visible by opening
	 * the landing. It costs one `$facet` over the active variants — the page already runs the
	 * catalogue aggregation, so this is one more pass over the same collection, not a query per
	 * tile.
	 */
	async findActive(categoryId?: string) {
		if (categoryId) this.assertObjectId(categoryId)
		const visible = await this.publicLandingCategories()
		const landings = (await this.landingRepository.findActive(categoryId)).filter(
			landing =>
				!visible ||
				LandingService.landingFits(
					landing as never,
					visible.get(String(landing.category_id))?.version
				)
		)
		const counts = await this.landingCounts(landings)
		return landings.map(landing => ({
			...landing,
			product_count: counts.get(String(landing._id)) ?? 0
		}))
	}

	/** PUBLIC — the sitemap's source of landing URLs; active only. */
	async findActiveSlugs() {
		const visible = await this.publicLandingCategories()
		if (!visible) return this.landingRepository.findActiveSlugs()
		// The slug rows carry no contract fields, so the fit is decided on the landing documents.
		const fitting = new Set(
			(await this.landingRepository.findActive())
				.filter(landing =>
					LandingService.landingFits(
						landing as never,
						visible.get(String(landing.category_id))?.version
					)
				)
				.map(landing => `${visible.get(String(landing.category_id))!.slug}/${landing.slug}`)
		)
		return (await this.landingRepository.findActiveSlugs()).filter(row =>
			fitting.has(`${row.category_slug}/${row.slug}`)
		)
	}

	/**
	 * ADMIN — drafts included, each with `product_count`: how many catalogue variants its
	 * pinned filters match (Plan-0005 D3).
	 *
	 * That number is the column the editor works from. A landing matching nothing is the
	 * failure this screen exists to make visible — it would otherwise reach the sitemap as an
	 * empty page — and it is the same count {@link assertLandingHasProducts} refuses to
	 * publish on, so the screen and the guard can never disagree.
	 */
	async findAllForAdmin(categoryId?: string) {
		if (categoryId) this.assertObjectId(categoryId)
		const landings = await this.landingRepository.findAllForAdmin(categoryId)
		const counts = await this.landingCounts(landings)
		return landings.map(landing => ({
			...landing,
			product_count: counts.get(String(landing._id)) ?? 0
		}))
	}

	/**
	 * PUBLIC — resolves `/{categorySlug}/{landingSlug}`. An unknown category, an unknown slug
	 * and a draft are all the same 404, so the storefront renders `notFound()` and never leaks
	 * that an unpublished page exists at that address.
	 */
	async findActiveBySlugs(categorySlug: string, landingSlug: string) {
		const category = await this.categoryRepository.findBySlug(categorySlug)
		if (!category) throw new NotFoundException('Landing not found')
		const visible = await this.publicLandingCategories()
		const version = visible?.get(String(category._id))?.version
		if (visible && version === undefined) throw new NotFoundException('Landing not found')

		const landing = await this.landingRepository.findActiveByCategoryAndSlug(
			category._id,
			landingSlug
		)
		if (!landing) throw new NotFoundException('Landing not found')
		if (visible && !LandingService.landingFits(landing.toObject(), version))
			throw new NotFoundException('Landing not found')

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

		if (dto.status === LandingStatus.ACTIVE) {
			await this.assertLandingHasProducts(dto.category_id, dto.filters ?? {})
		}

		const created = await this.landingRepository.create({
			...sanitizeLandingCopy(dto),
			slug,
			category_id: new Types.ObjectId(dto.category_id)
		})
		this.revalidation.revalidate('landings', 'create')
		return created
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

		// Checked against the state the save would leave behind, not against the request: a
		// PATCH that only narrows `filters` can empty an already published landing just as
		// surely as one that flips `status`.
		const status = dto.status ?? current.status
		if (status === LandingStatus.ACTIVE) {
			await this.assertLandingHasProducts(categoryId, dto.filters ?? current.filters)
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
		this.revalidation.revalidate('landings', 'update')
		return updated
	}

	async delete(id: string) {
		this.assertObjectId(id)
		const deleted = await this.landingRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Landing not found')
		this.revalidation.revalidate('landings', 'delete')
		return { success: true }
	}

	/**
	 * A published landing that matches nothing is an indexed empty page: it enters the sitemap,
	 * Google crawls it, and the shopper lands on "нічого не знайдено". Plan-0004's acceptance
	 * criterion is that each of the 14 landings returns a non-empty listing, and until now that
	 * held only by the editor's discipline (Plan-0005 D6).
	 */
	private async assertLandingHasProducts(
		categoryId: string,
		filters: Record<string, string[]>
	): Promise<void> {
		const counts = await this.productVariantRepository.countVariantsForLandings([
			{ id: 'candidate', category_id: new Types.ObjectId(categoryId), filters }
		])
		if ((counts.get('candidate') ?? 0) === 0) {
			throw new ConflictException(
				'Під закріплені фільтри не підпадає жоден товар — такий лендінг не можна публікувати. Збережіть його як чернетку або змініть фільтри.'
			)
		}
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
			throw new ConflictException(`Лендінг «${slug}» уже існує в цій категорії`)
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
