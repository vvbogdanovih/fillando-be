import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import {
	StorefrontRevalidationService,
	storefrontRevalidation
} from 'src/common/services/storefront-revalidation.service'
import { generateAttrKey } from 'src/common/utils'
import { CreateCategoryDto, RequiredAttributeDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'

@Injectable()
export class CategoryService {
	private readonly logger = new Logger(CategoryService.name)

	constructor(
		private readonly categoryRepository: CategoryRepository,
		/**
		 * Not a registered provider: `@Optional()` leaves it `undefined` and the default takes
		 * over, so this service shares one throttle window with the product and colour writes
		 * (see the singleton's own note). A spec passes its own instance.
		 */
		@Optional()
		private readonly revalidation: StorefrontRevalidationService = storefrontRevalidation
	) {}

	findAll() {
		return this.categoryRepository.findAll({})
	}

	async findById(id: string) {
		const category = await this.categoryRepository.findById(id)
		if (!category) throw new NotFoundException('Category not found')
		return category
	}

	async findBySlug(slug: string) {
		const category = await this.categoryRepository.findBySlug(slug)
		if (!category) throw new NotFoundException('Category not found')
		return category
	}

	private mapRequiredAttributes(attributes?: RequiredAttributeDto[]) {
		return attributes?.map(attr => ({
			key: generateAttrKey(attr.label),
			label: attr.label,
			filter_type: attr.filter_type,
			is_required: attr.is_required,
			unit: attr.unit ?? null
		}))
	}

	private withMappedAttributes<T extends { required_attributes?: RequiredAttributeDto[] }>(
		dto: T
	) {
		const required_attributes = this.mapRequiredAttributes(dto.required_attributes)
		return {
			...dto,
			...(required_attributes !== undefined && { required_attributes })
		}
	}

	/**
	 * Every write here purges the storefront's `categories` reads.
	 *
	 * A category is not just its own page: `required_attributes` is where the catalogue's filter
	 * dimensions and the specification table's units come from, and the name is in every
	 * breadcrumb. Waiting out the hour shows a sidebar filtering on a dimension the category no
	 * longer has (I-h).
	 */
	async create(dto: CreateCategoryDto) {
		const created = await this.categoryRepository.create(this.withMappedAttributes(dto))
		this.revalidation.revalidate('categories', 'category create')
		return created
	}

	async update(id: string, dto: UpdateCategoryDto) {
		const updated = await this.categoryRepository.update(
			{ _id: id },
			this.withMappedAttributes(dto)
		)
		if (!updated) throw new NotFoundException('Category not found')
		this.revalidation.revalidate('categories', 'category update')
		return updated
	}

	async replace(id: string, dto: CreateCategoryDto) {
		const replaced = await this.categoryRepository.update(
			{ _id: id },
			{ $set: this.withMappedAttributes(dto) }
		)
		if (!replaced) throw new NotFoundException('Category not found')
		this.revalidation.revalidate('categories', 'category replace')
		return replaced
	}

	async delete(id: string) {
		const deleted = await this.categoryRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Category not found')
		this.revalidation.revalidate('categories', 'category delete')
		return { message: 'Category deleted' }
	}
}
