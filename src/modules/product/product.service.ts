import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ProductRepository } from 'src/database/mongoose/repositories/product.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'
import { generateAttrKey, generateSlug } from 'src/common/utils/attribute.utils'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { ValidateProductDto, ValidateProductResponseDto } from './dto/validate-product.dto'
import { SetVariantImagesDto } from './dto/set-variant-images.dto'
import { AddVariantDto, UpdateVariantDto } from './dto/update-variant.dto'
import { SearchProductsDto } from './dto/search-products.dto'

@Injectable()
export class ProductService {
	private readonly logger = new Logger(ProductService.name)

	constructor(
		private readonly productRepository: ProductRepository,
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly numbersRepository: NumbersRepository
	) {}

	private async generateSku(): Promise<string> {
		const num = await this.numbersRepository.increment('sku')
		return `FL-${String(num).padStart(6, '0')}`
	}

	async search(dto: SearchProductsDto) {
		const { q, page = 1, limit = 20 } = dto

		const [textResults, skuResults] = await Promise.all([
			this.productRepository.findByTextSearch(q),
			this.productVariantRepository.findBySkuPrefix(q)
		])

		const productIds = textResults.map(r => r._id)
		const skuVariantIds = skuResults.map(r => r._id)

		return this.productVariantRepository.findSearchResults({
			productIds,
			skuVariantIds,
			page,
			limit
		})
	}

	findAll() {
		return this.productRepository.findAll({})
	}

	getAllVariantSlugs(): Promise<Array<{ slug: string; updatedAt: Date }>> {
		return this.productVariantRepository.findAllSlugs()
	}

	async getVariantCount(): Promise<{ count: number }> {
		const count = await this.productVariantRepository.countAll()
		return { count }
	}

	async getCatalog(rawQuery: Record<string, string>) {
		const { subcategory_id, page, limit, price_min, price_max, sort, ...rest } = rawQuery

		if (!subcategory_id) throw new BadRequestException('subcategory_id is required')

		const knownKeys = new Set([
			'subcategory_id',
			'page',
			'limit',
			'price_min',
			'price_max',
			'sort'
		])
		const attrFilters: Record<string, string[]> = {}
		for (const [key, value] of Object.entries(rest)) {
			if (!knownKeys.has(key) && typeof value === 'string') {
				attrFilters[key] = value
					.split(',')
					.map(v => v.trim())
					.filter(Boolean)
			}
		}

		return this.productVariantRepository.findCatalogItems({
			subcategory_id,
			page: page ? Math.max(1, parseInt(page, 10)) : 1,
			limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 20,
			price_min: price_min !== undefined ? parseFloat(price_min) : undefined,
			price_max: price_max !== undefined ? parseFloat(price_max) : undefined,
			sort: sort ?? 'newest',
			attrFilters
		})
	}

	async getVariantBySlug(slug: string) {
		const result = await this.productVariantRepository.findVariantWithProduct(slug)
		if (!result) throw new NotFoundException('Variant not found')
		return result
	}

	async findById(id: string) {
		const product = await this.productRepository.findById(id)
		if (!product) throw new NotFoundException('Product not found')
		return product
	}

	async create(dto: CreateProductDto) {
		const attributes = dto.attributes?.map(attr => ({
			k: generateAttrKey(attr.l),
			l: attr.l,
			v: attr.v
		}))

		const { variants, ...productData } = dto
		const product = await this.productRepository.create({ ...productData, attributes } as any)

		const createdVariants = variants?.length
			? await Promise.all(
					variants.map(async variant => {
						const systemSku = await this.generateSku()
						const slug = generateSlug(
							variant.v_value ? `${product.name} ${variant.v_value}` : product.name
						)
						return this.productVariantRepository.create({
							...variant,
							sku: systemSku,
							vendor_product_sku: variant.vendor_product_sku ?? systemSku,
							product_id: product._id,
							subcategory_id: new Types.ObjectId(
								String((product as any).subcategory_id)
							),
							name: variant.v_value
								? `${product.name} — ${variant.v_value}`
								: product.name,
							slug,
							stock: variant.stock ?? 0,
							images: variant.images ?? []
						})
					})
				)
			: []

		return { ...product.toObject(), variants: createdVariants.map(v => v.toObject()) }
	}

	async update(id: string, dto: UpdateProductDto) {
		const attributes = dto.attributes?.map(attr => ({
			k: generateAttrKey(attr.l),
			l: attr.l,
			v: attr.v
		}))
		const updated = await this.productRepository.update(
			{ _id: id },
			{
				...dto,
				attributes
			}
		)
		if (!updated) throw new NotFoundException('Product not found')

		if (dto.name) {
			const variants = await this.productVariantRepository.findByProductId(id)
			await Promise.all(
				variants.map(v =>
					this.productVariantRepository.update(
						{ _id: (v as any)._id } as any,
						{
							name: (v as any).v_value
								? `${dto.name} — ${(v as any).v_value}`
								: dto.name,
							slug: generateSlug(
								(v as any).v_value ? `${dto.name} ${(v as any).v_value}` : dto.name!
							)
						} as any
					)
				)
			)
		}

		return updated
	}

	async delete(id: string) {
		const deleted = await this.productRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Product not found')
		return { message: 'Product deleted' }
	}

	async validate(dto: ValidateProductDto): Promise<ValidateProductResponseDto> {
		const [slugResults, skuResults] = await Promise.all([
			Promise.all(dto.slugs.map(slug => this.productVariantRepository.findBySlug(slug))),
			Promise.all(dto.skus.map(sku => this.productVariantRepository.findBySku(sku)))
		])

		return {
			slugs: dto.slugs.filter((_, i) => !!slugResults[i]),
			skus: dto.skus.filter((_, i) => !!skuResults[i])
		}
	}

	async getVariants(productId: string) {
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')
		return this.productVariantRepository.findByProductId(productId)
	}

	async getVariant(productId: string, variantId: string) {
		const variant = await this.productVariantRepository.findOne({
			_id: new Types.ObjectId(variantId),
			product_id: new Types.ObjectId(productId)
		})
		if (!variant) throw new NotFoundException('Variant not found')
		return variant
	}

	async addVariant(productId: string, dto: AddVariantDto) {
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')

		const systemSku = await this.generateSku()
		return this.productVariantRepository.create({
			...dto,
			sku: systemSku,
			vendor_product_sku: dto.vendor_product_sku ?? systemSku,
			product_id: product._id,
			subcategory_id: new Types.ObjectId(String((product as any).subcategory_id)),
			name: dto.v_value ? `${product.name} — ${dto.v_value}` : product.name,
			slug: generateSlug(dto.v_value ? `${product.name} ${dto.v_value}` : product.name),
			stock: dto.stock ?? 0,
			images: dto.images ?? []
		})
	}

	async updateVariant(productId: string, variantId: string, dto: UpdateVariantDto) {
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')

		const patch: Record<string, any> = { ...dto }
		if ('v_value' in dto) {
			patch.name = dto.v_value ? `${product.name} — ${dto.v_value}` : product.name
			patch.slug = generateSlug(dto.v_value ? `${product.name} ${dto.v_value}` : product.name)
		}
		if ('price' in dto) patch.price_updated_at = new Date()
		if ('stock' in dto) patch.stock_updated_at = new Date()

		const updated = await this.productVariantRepository.update(
			{
				_id: new Types.ObjectId(variantId),
				product_id: new Types.ObjectId(productId)
			},
			patch as any
		)
		if (!updated) throw new NotFoundException('Variant not found')
		return updated
	}

	async deleteVariant(productId: string, variantId: string) {
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')

		const deleted = await this.productVariantRepository.delete({
			_id: new Types.ObjectId(variantId),
			product_id: new Types.ObjectId(productId)
		})
		if (!deleted) throw new NotFoundException('Variant not found')
		return { message: 'Variant deleted' }
	}

	async setVariantImages(productId: string, variantId: string, dto: SetVariantImagesDto) {
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')

		const updated = await this.productVariantRepository.update(
			{
				_id: new Types.ObjectId(variantId),
				product_id: new Types.ObjectId(productId)
			},
			{ $set: { images: dto.images } }
		)
		if (!updated) throw new NotFoundException('Variant not found')
		return updated
	}
}
