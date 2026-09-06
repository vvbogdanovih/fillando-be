import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException
} from '@nestjs/common'
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
import type { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'
import {
	MANUFACTURER_PATTERNS,
	MATERIAL_PATTERNS,
	pickAttr,
	pickColor,
	type AttrLike
} from './product-attribute.helpers'

/** What a `color_id` on the wire resolves to: the pair stored on the variant, plus its label. */
interface ResolvedColor {
	stored: { color_id: Types.ObjectId | null; color_family: ColorFamily | null }
	/** «Чорний (Black)» — the shopper-facing spelling, already formatted. */
	label: string | null
}

/** A stored variant as the rename planner reads it — `_id` is not declared on the schema class. */
type StoredVariant = ProductVariant & { _id: Types.ObjectId }

/** One variant's regenerated identity, vetted before any of them is written. */
interface PlannedRename {
	id: Types.ObjectId
	sku: string
	name: string
	slug: string
	/** What it occupies right now — the difference decides whether it has to move at all. */
	currentSlug: string
}

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
	): Promise<ResolvedColor | undefined> {
		if (colorId === undefined) return undefined
		if (colorId === null || colorId === '')
			return { stored: { color_id: null, color_family: null }, label: null }

		if (!Types.ObjectId.isValid(colorId)) throw new BadRequestException('Unknown colour')
		const color = await this.colorRepository.findById(colorId)
		if (!color) throw new BadRequestException('Unknown colour')

		return {
			stored: { color_id: color._id, color_family: color.family },
			label: formatColorLabel(color.name_uk, color.name_en)
		}
	}

	/** Dictionary spelling behind a colour already stored on a variant, formatted for a shopper. */
	private async storedColorLabel(colorId: Types.ObjectId | null | undefined) {
		if (!colorId) return null
		const color = await this.colorRepository.findById(String(colorId))
		return color ? formatColorLabel(color.name_uk, color.name_en) : null
	}

	/**
	 * The shopper-facing name of a variant.
	 *
	 * `v_value` holds the canonical English dictionary spelling (`colors.name_en`) and the slug
	 * is built from it, but the name shown in the catalogue listing, the price sheet, the cart
	 * and the order snapshot is the shopper-facing «Чорний (Black)» — Ukrainian first, the
	 * manufacturer's own spelling in brackets, the same form the product page prints. Storing it
	 * here is what makes the cart, the order snapshot and the confirmation e-mail agree with the
	 * page the shopper bought from, none of which joins the dictionary itself (Plan-0005 C1). Deriving the name from `v_value` instead renamed every migrated
	 * variant to English on the first save, one product at a time, leaving the catalogue in two
	 * languages. The dictionary wins whenever the variant points at it; `v_value` is the fallback
	 * for variants that carry no colour.
	 */
	private variantName(
		productName: string,
		vValue: string | null | undefined,
		colorLabel: string | null
	): string {
		// `||`, not `??`: a dictionary row saved with a blank name would otherwise swallow the
		// suffix entirely and silently rename the variant to the bare product name.
		const suffix = colorLabel?.trim() || vValue
		return suffix ? `${productName} — ${suffix}` : productName
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

	/**
	 * Public product page. DRAFT variants are a 404 here (the repository filters them); ARCHIVED
	 * ones come back with their status so the storefront renders «Знято з продажу» (TD-0006 §5.4).
	 * `manufacturer` is the «Виробник» attribute — the same helper the price sheet uses — and
	 * never the vendor: `Vendor` is the supplier, not the brand.
	 */
	async getVariantBySlug(slug: string) {
		const result = await this.productVariantRepository.findVariantWithProduct(slug)
		if (!result) throw new NotFoundException('Variant not found')
		const attributes: AttrLike[] = Array.isArray(result.product.attributes)
			? (result.product.attributes as AttrLike[])
			: []
		return {
			...result,
			product: {
				...result.product,
				manufacturer: pickAttr(attributes, MANUFACTURER_PATTERNS)
			}
		}
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
							...(color?.stored ?? {}),
							sku: systemSku,
							vendor_product_sku: variant.vendor_product_sku ?? systemSku,
							product_id: product._id,
							category_id: new Types.ObjectId(String(product.category_id)),
							name: this.variantName(
								product.name,
								variant.v_value,
								color?.label ?? null
							),
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
		const current = await this.productRepository.findById(id)
		if (!current) throw new NotFoundException('Product not found')

		// Only an actual change of name regenerates variant identities. The admin form posts `name`
		// on every save, so keying off its presence would re-plan — and re-reject — on edits that
		// have nothing to do with the name, locking a product with a duplicate out of every field.
		const renaming = dto.name !== undefined && dto.name !== current.name

		// A rename regenerates the slug of every variant, and `slug` is unique. Plan and vet the
		// whole batch *before* the first write: there is no transaction to fall back on (this
		// deployment runs a standalone MongoDB), so a duplicate discovered mid-batch used to leave
		// the product renamed and only some of its variants rewritten.
		const rename = renaming ? await this.planVariantRename(id, dto.name!) : null

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

		if (rename) await this.applyVariantRename(rename)

		return updated
	}

	/**
	 * Writes a planned rename in two passes.
	 *
	 * One pass is not enough because slugs can *rotate* within a product: variant A's new address
	 * is the one variant B is still sitting on until B is written too. Order is not something a
	 * concurrent batch can guarantee and there is no transaction to wrap it in, so the losing write
	 * hits the unique index and the rename half-applies. Parking every mover on a temporary address
	 * first empties the whole target range, after which the second pass cannot collide: the
	 * pre-flight has already ruled out duplicates inside the plan and holders outside the product.
	 */
	private async applyVariantRename(planned: PlannedRename[]): Promise<void> {
		const movers = planned.filter(p => p.slug !== p.currentSlug)
		const stayers = planned.filter(p => p.slug === p.currentSlug)

		await Promise.all(
			movers.map(p =>
				this.productVariantRepository.update(
					{ _id: p.id },
					{ slug: `${p.slug}-moving-${String(p.id)}` }
				)
			)
		)

		await Promise.all(
			[...movers, ...stayers].map(p =>
				this.productVariantRepository.update({ _id: p.id }, { name: p.name, slug: p.slug })
			)
		)
	}

	/**
	 * Works out what every variant of a product would be called after a rename, and refuses the
	 * rename outright if two of them would end up at the same address.
	 */
	private async planVariantRename(
		productId: string,
		productName: string
	): Promise<PlannedRename[]> {
		const variants = (await this.productVariantRepository.findByProductId(
			productId
		)) as StoredVariant[]
		if (!variants.length) return []

		const colorIds = variants.map(v => v.color_id).filter((id): id is Types.ObjectId => !!id)
		const colors = colorIds.length ? await this.colorRepository.findByIds(colorIds) : []
		const nameByColorId = new Map(
			colors.map(c => [String(c._id), formatColorLabel(c.name_uk, c.name_en)])
		)

		const planned = variants.map(v => ({
			id: v._id,
			sku: v.sku,
			currentSlug: v.slug,
			name: this.variantName(
				productName,
				v.v_value,
				v.color_id ? (nameByColorId.get(String(v.color_id)) ?? null) : null
			),
			slug: generateSlug(v.v_value ? `${productName} ${v.v_value}` : productName)
		}))

		await this.assertSlugsAvailable(planned)
		return planned
	}

	/** 409 naming the SKUs, rather than a duplicate-key error partway through the batch. */
	private async assertSlugsAvailable(planned: PlannedRename[]): Promise<void> {
		const skusBySlug = new Map<string, string[]>()
		for (const p of planned) skusBySlug.set(p.slug, [...(skusBySlug.get(p.slug) ?? []), p.sku])

		const clashing = [...skusBySlug.entries()].filter(([, skus]) => skus.length > 1)
		if (clashing.length) {
			throw new ConflictException(
				'Rename refused: these variants would share one address — ' +
					clashing.map(([slug, skus]) => `${skus.join(' + ')} → ${slug}`).join('; ') +
					'. Give them different variant values, or merge the duplicates.'
			)
		}

		const ownIds = new Set(planned.map(p => String(p.id)))
		const taken = (
			(await this.productVariantRepository.findBySlugs([
				...skusBySlug.keys()
			])) as StoredVariant[]
		).filter(v => !ownIds.has(String(v._id)))

		if (taken.length) {
			throw new ConflictException(
				'Rename refused: these addresses already belong to other products — ' +
					taken.map(v => `${v.slug} (${v.sku})`).join(', ')
			)
		}
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
			...(color?.stored ?? {}),
			sku: systemSku,
			vendor_product_sku: dto.vendor_product_sku ?? systemSku,
			product_id: product._id,
			category_id: new Types.ObjectId(String(product.category_id)),
			name: this.variantName(product.name, dto.v_value, color?.label ?? null),
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

		const existing = await this.productVariantRepository.findOne({
			_id: new Types.ObjectId(variantId),
			product_id: new Types.ObjectId(productId)
		})
		if (!existing) throw new NotFoundException('Variant not found')

		const patch: Record<string, any> = { ...dto }
		const color = await this.resolveColor(dto.color_id)
		if (color) Object.assign(patch, color.stored)

		// `'field' in dto` is true even when the caller never sent it: `target: ES2023` gives every
		// declared DTO field an own property. Reading it as "the client mentioned this" made a
		// stock-only PATCH rewrite name and slug from an undefined value — collapsing the variant's
		// address onto the product's — and stamped both freshness dates on edits that touched
		// neither, which shoppers see as "synced just now" on the price sheet. Compare with
		// `undefined` throughout.
		if (dto.v_value !== undefined || color) {
			// Either half can be the one that moved: a request that changes only the colour still
			// needs a new name, and one that changes only `v_value` needs the colour already stored.
			const vValue = dto.v_value !== undefined ? dto.v_value : existing.v_value
			const colorLabel = color ? color.label : await this.storedColorLabel(existing.color_id)
			patch.name = this.variantName(product.name, vValue, colorLabel)
			patch.slug = generateSlug(vValue ? `${product.name} ${vValue}` : product.name)
		}
		if (dto.price !== undefined) patch.price_updated_at = new Date()
		if (dto.stock !== undefined) patch.stock_updated_at = new Date()

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
	// Trimmed before the emptiness checks, not after: a dictionary row saved with a blank-looking
	// `name_uk` is truthy as a string, and the untrimmed version answered « (Black)» — a label
	// starting with a space, which reached the price sheet and now the variant name too.
	const uk = nameUk?.trim()
	const en = nameEn?.trim()
	if (!uk && !en) return null
	if (!uk) return en as string
	if (!en || en === uk) return uk
	return `${uk} (${en})`
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
