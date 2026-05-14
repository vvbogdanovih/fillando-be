import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { generateAttrKey } from 'src/common/utils'
import { CreateCategoryDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'
import { CreateSubcategoryDto } from './dto/create-subcategory.dto'

@Injectable()
export class CategoryService {
	private readonly logger = new Logger(CategoryService.name)

	constructor(private readonly categoryRepository: CategoryRepository) {}

	findAll() {
		return this.categoryRepository.findAll({})
	}

	findWithSubcategories() {
		return this.categoryRepository.findWithSubcategories()
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

	create(dto: CreateCategoryDto) {
		return this.categoryRepository.create(dto)
	}

	async update(id: string, dto: UpdateCategoryDto) {
		const updated = await this.categoryRepository.update({ _id: id }, dto)
		if (!updated) throw new NotFoundException('Category not found')
		return updated
	}

	async replace(id: string, dto: CreateCategoryDto) {
		const replaced = await this.categoryRepository.update({ _id: id }, { $set: dto })
		if (!replaced) throw new NotFoundException('Category not found')
		return replaced
	}

	async delete(id: string) {
		const deleted = await this.categoryRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Category not found')
		return { message: 'Category deleted' }
	}

	async findSubcategories(categoryId: string) {
		const subcategories = await this.categoryRepository.findSubcategories(categoryId)
		if (subcategories === null) throw new NotFoundException('Category not found')
		return subcategories
	}

	async findSubcategoryById(categoryId: string, subcategoryId: string) {
		const subcategory = await this.categoryRepository.findSubcategoryById(
			categoryId,
			subcategoryId
		)
		if (!subcategory) throw new NotFoundException('Subcategory not found')
		return subcategory
	}

	private mapRequiredAttributes(dto: CreateSubcategoryDto) {
		return dto.required_attributes?.map(attr => ({
			key: generateAttrKey(attr.label),
			label: attr.label,
			filter_type: attr.filter_type,
			unit: attr.unit ?? null
		}))
	}

	async addSubcategory(categoryId: string, dto: CreateSubcategoryDto) {
		const payload = { ...dto, required_attributes: this.mapRequiredAttributes(dto) }
		const updated = await this.categoryRepository.addSubcategory(categoryId, payload)
		if (!updated) throw new NotFoundException('Category not found')
		return updated
	}

	async updateSubcategory(
		categoryId: string,
		subcategoryId: string,
		dto: Partial<CreateSubcategoryDto>
	) {
		const required_attributes = dto.required_attributes
			? dto.required_attributes.map(attr => ({
					key: generateAttrKey(attr.label),
					label: attr.label,
					filter_type: attr.filter_type,
					unit: attr.unit ?? null
				}))
			: undefined
		const payload = {
			...dto,
			...(required_attributes !== undefined && { required_attributes })
		}
		const updated = await this.categoryRepository.updateSubcategory(
			categoryId,
			subcategoryId,
			payload as any
		)
		if (!updated) throw new NotFoundException('Category or subcategory not found')
		return updated
	}

	async replaceSubcategory(categoryId: string, subcategoryId: string, dto: CreateSubcategoryDto) {
		const payload = { ...dto, required_attributes: this.mapRequiredAttributes(dto) }
		const updated = await this.categoryRepository.replaceSubcategory(
			categoryId,
			subcategoryId,
			payload as any
		)
		if (!updated) throw new NotFoundException('Category or subcategory not found')
		return updated
	}

	async removeSubcategory(categoryId: string, subcategoryId: string) {
		const updated = await this.categoryRepository.removeSubcategory(categoryId, subcategoryId)
		if (!updated) throw new NotFoundException('Category not found')
		return updated
	}
}
