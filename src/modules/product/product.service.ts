import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ProductRepository } from 'src/database/mongoose/repositories/product.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'
import { generateAttrKey, generateSlug } from 'src/common/utils/attribute.utils'
import { sanitizeRichText } from 'src/common/utils/html.utils'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { ValidateProductDto, ValidateProductResponseDto } from './dto/validate-product.dto'
import { SetVariantImagesDto } from './dto/set-variant-images.dto'
import { AddVariantDto, UpdateVariantDto } from './dto/update-variant.dto'
import { SearchProductsDto } from './dto/search-products.dto'
import { GetPriceSheetQueryDto } from './dto/get-price-sheet-query.dto'
import { ColorRepository } from 'src/database/mongoose/repositories/color.repository'
import { ColorFamily } from 'src/common/types/enums'
import {
	MANUFACTURER_PATTERNS,
	MATERIAL_PATTERNS,
	pickAttr,
	pickColor,
	type AttrLike
} from './product-attribute.helpers'

interface PriceSheetRaw {
	id: string
	product_name: string
	slug: string
	v_value: string | null
	sku: string
	color_name_uk?: string | null
	color_name_en?: string | null
	price: number
	stock?: number
	stock_updated_at?: Date | null
	image?: string | null
	attributes?: AttrLike[]
	variant_type?: { key?: string; label?: string } | null
}

@Injectable()
export class ProductService {
	private readonly logger = new Logger(ProductService.name)

	constructor(
		private readonly productRepository: ProductRepository,
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly numbersRepository: NumbersRepository,
		private readonly colorRepository: ColorRepository
	) {}

	/**
	 * Resolves an incoming `color_id` into the pair actually stored on a variant.
	 *
	 * `color_family` is denormalized from the dictionary (TD-0002 §5.2.2), so it can never be
	 * accepted from the client — it is looked up here, on every write, or the catalogue filter
	 * ends up disagreeing with the colour shown on the product. A `color_id` the dictionary does
	 * not know is refused rather than stored as a dangling reference.
	 *
	 * Returns `undefined` when the request said nothing about colour, so a partial update leaves
	 * the existing values alone.
	 */
	private async resolveColor(
		colorId: string | null | undefined
	): Promise<{ color_id: Types.ObjectId | null; color_family: ColorFamily | null } | undefined> {
		if (colorId === undefined) return undefined
		if (colorId === null || colorId === '') return { color_id: null, color_family: null }

		if (!Types.ObjectId.isValid(colorId)) throw new BadRequestException('Unknown colour')
		const color = await this.colorRepository.findById(colorId)
		if (!color) throw new BadRequestException('Unknown colour')

		return { color_id: color._id, color_family: color.family }
	}

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

	/**
	 * Flat, paginated variant list for the public price-sheet table. The repository already
	 * restricts rows to ACTIVE variants and to public fields; this mapper only reshapes them.
	 */
	async getPriceSheet(query: GetPriceSheetQueryDto) {
		const { q, page = 1, limit = 50 } = query
		const { items, total } = await this.productVariantRepository.findPriceSheet({
			q,
			page,
			limit
		})

		const rows = (items as PriceSheetRaw[]).map(item => {
			const attributes = Array.isArray(item.attributes) ? item.attributes : []
			return {
				id: item.id,
				slug: item.slug,
				image: item.image ?? null,
				name: item.product_name,
				manufacturer: pickAttr(attributes, MANUFACTURER_PATTERNS),
				material: pickAttr(attributes, MATERIAL_PATTERNS),
				// Dictionary first: after the colour migration `v_value` is the English name, so
				// deriving the label from the variant alone would flip the sheet to English.
				// Kept a plain string — the storefront validates this field as one.
				color:
					formatColorLabel(item.color_name_uk, item.color_name_en) ??
					pickColor(item.v_value, attributes, item.variant_type),
				article: item.sku || null,
				price: item.price,
				in_stock: (item.stock ?? 0) > 0,
				stock: item.stock ?? 0,
				synced_at: item.stock_updated_at ?? null
			}
		})

		return { items: rows, total, page, limit }
	}

	getAllVariantSlugs(): Promise<Array<{ slug: string; updatedAt: Date }>> {
		return this.productVariantRepository.findAllSlugs()
	}

	async getVariantCount(): Promise<{ count: number }> {
		const count = await this.productVariantRepository.countAll()
		return { count }
	}

	async getCatalog(rawQuery: Record<string, string>) {
		const { category_id, page, limit, price_min, price_max, sort, color_family, ...rest } =
			rawQuery

		if (!category_id) throw new BadRequestException('category_id is required')

		const attrFilters: Record<string, string[]> = {}
		for (const [key, value] of Object.entries(rest)) {
			if (!CATALOG_RESERVED_KEYS.has(key) && typeof value === 'string') {
				attrFilters[key] = splitFilterValues(value)
			}
		}

		return this.productVariantRepository.findCatalogItems({
			category_id,
			page: page ? Math.max(1, parseInt(page, 10)) : 1,
			limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 20,
			price_min: price_min !== undefined ? parseFloat(price_min) : undefined,
			price_max: price_max !== undefined ? parseFloat(price_max) : undefined,
			sort: sort ?? 'newest',
			attrFilters,
			// Colour lives on the variant, not in `product.attributes`, so it cannot go through
			// `attrFilters` — an `$elemMatch` on `attributes` would match nothing at all.
			colorFamilies: color_family ? splitFilterValues(color_family) : []
		})
	}

	/** Public product page. Non-ACTIVE variants are a 404 here (repository filters them). */
	async getVariantBySlug(slug: string) {
		const result = await this.productVariantRepository.findVariantWithProduct(slug)
		if (!result) throw new NotFoundException('Variant not found')
		return result
	}

	async findById(id: string) {
		this.assertObjectId(id, 'Product not found')
		const product = await this.productRepository.findById(id)
		if (!product) throw new NotFoundException('Product not found')
		return product
	}

	/** A malformed id is "not found", never a BSONError 500. */
	private assertObjectId(id: string, message: string): void {
		if (!Types.ObjectId.isValid(id)) throw new NotFoundException(message)
	}

	async create(dto: CreateProductDto) {
		const attributes = dto.attributes?.map(attr => ({
			k: generateAttrKey(attr.l),
			l: attr.l,
			v: attr.v
		}))

		const { variants, ...productData } = withSanitizedDescription(dto)
		const product = await this.productRepository.create({ ...productData, attributes } as any)

		const createdVariants = variants?.length
			? await Promise.all(
					variants.map(async variant => {
						const systemSku = await this.generateSku()
						const slug = generateSlug(
							variant.v_value ? `${product.name} ${variant.v_value}` : product.name
						)
						// `color_id` arrives as a string and is replaced by the resolved pair,
						// so it must not survive the spread.
						const { color_id: _colorId, ...variantData } = variant
						const color = await this.resolveColor(variant.color_id)
						return this.productVariantRepository.create({
							...variantData,
							...(color ?? {}),
							sku: systemSku,
							vendor_product_sku: variant.vendor_product_sku ?? systemSku,
							product_id: product._id,
							category_id: new Types.ObjectId(String(product.category_id)),
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
				...withSanitizedDescription(dto),
				attributes
			}
		)
		if (!updated) throw new NotFoundException('Product not found')

		// Variants denormalize category_id — keep them in sync when the product is moved.
		if (dto.category_id) {
			await this.productVariantRepository.updateCategoryByProductId(
				id,
				String(dto.category_id)
			)
		}

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

	/** Admin only — returns full variant documents (incl. supplier fields) for editing. */
	async getVariants(productId: string) {
		if (!Types.ObjectId.isValid(productId)) throw new NotFoundException('Product not found')
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')
		return this.productVariantRepository.findByProductId(productId)
	}

	/** Admin only — returns the full variant document (incl. supplier fields) for editing. */
	async getVariant(productId: string, variantId: string) {
		// A malformed id must be a 404, not a BSONError-turned-500 from `new ObjectId()`.
		if (!Types.ObjectId.isValid(productId) || !Types.ObjectId.isValid(variantId)) {
			throw new NotFoundException('Variant not found')
		}
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
		const { color_id: _colorId, ...variantData } = dto
		const color = await this.resolveColor(dto.color_id)
		return this.productVariantRepository.create({
			...variantData,
			...(color ?? {}),
			sku: systemSku,
			vendor_product_sku: dto.vendor_product_sku ?? systemSku,
			product_id: product._id,
			category_id: new Types.ObjectId(String(product.category_id)),
			name: dto.v_value ? `${product.name} — ${dto.v_value}` : product.name,
			slug: generateSlug(dto.v_value ? `${product.name} ${dto.v_value}` : product.name),
			stock: dto.stock ?? 0,
			images: dto.images ?? []
		})
	}

	async updateVariant(productId: string, variantId: string, dto: UpdateVariantDto) {
		this.assertObjectId(productId, 'Product not found')
		this.assertObjectId(variantId, 'Variant not found')
		const product = await this.productRepository.findById(productId)
		if (!product) throw new NotFoundException('Product not found')

		const patch: Record<string, any> = { ...dto }
		const color = await this.resolveColor(dto.color_id)
		if (color) Object.assign(patch, color)
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
		this.assertObjectId(productId, 'Product not found')
		this.assertObjectId(variantId, 'Variant not found')
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
		this.assertObjectId(productId, 'Product not found')
		this.assertObjectId(variantId, 'Variant not found')
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

/**
 * Product descriptions are admin-authored HTML rendered with `dangerouslySetInnerHTML` on the
 * product page, so they go through the same allowlist as landing copy (TD-0002 §5.2.3 asked
 * for a shared helper). `json` is the editor's own delta and is never rendered as markup.
 */
function withSanitizedDescription<T extends { description?: { json: unknown; html: string } }>(
	dto: T
): T {
	if (!dto.description) return dto
	return {
		...dto,
		description: { ...dto.description, html: sanitizeRichText(dto.description.html) }
	}
}

/**
 * "Чорний (Black)" — the Ukrainian name a shopper reads plus the canonical name a reseller
 * orders by (TD-0002 §5.2.2). Null when the variant has no dictionary colour, so the caller
 * can fall back to the attribute-derived one.
 */
function formatColorLabel(
	nameUk: string | null | undefined,
	nameEn: string | null | undefined
): string | null {
	if (!nameUk && !nameEn) return null
	if (!nameUk) return nameEn as string
	if (!nameEn || nameEn === nameUk) return nameUk
	return `${nameUk} (${nameEn})`
}

/**
 * Query parameters the catalogue handles itself. Everything else is treated as a product
 * attribute filter, so a new reserved parameter MUST be listed here — otherwise it is sent to
 * Mongo as `attributes.k` and silently matches nothing.
 */
const CATALOG_RESERVED_KEYS = new Set([
	'category_id',
	'page',
	'limit',
	'price_min',
	'price_max',
	'sort',
	'color_family'
])

/** `?polymer=PLA,PETG` is an OR within one dimension. Values may never contain a comma. */
function splitFilterValues(value: string): string[] {
	return value
		.split(',')
		.map(v => v.trim())
		.filter(Boolean)
}
