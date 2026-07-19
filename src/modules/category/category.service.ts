import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { generateAttrKey } from 'src/common/utils'
import { CreateCategoryDto, RequiredAttributeDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'

@Injectable()
export class CategoryService {
	private readonly logger = new Logger(CategoryService.name)

	constructor(private readonly categoryRepository: CategoryRepository) {}

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

	create(dto: CreateCategoryDto) {
		return this.categoryRepository.create(this.withMappedAttributes(dto))
	}

	async update(id: string, dto: UpdateCategoryDto) {
		const updated = await this.categoryRepository.update(
			{ _id: id },
			this.withMappedAttributes(dto)
		)
		if (!updated) throw new NotFoundException('Category not found')
		return updated
	}

	async replace(id: string, dto: CreateCategoryDto) {
		const replaced = await this.categoryRepository.update(
			{ _id: id },
			{ $set: this.withMappedAttributes(dto) }
		)
		if (!replaced) throw new NotFoundException('Category not found')
		return replaced
	}

	async delete(id: string) {
		const deleted = await this.categoryRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Category not found')
		return { message: 'Category deleted' }
	}
}
