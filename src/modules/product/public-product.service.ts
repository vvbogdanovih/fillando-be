import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { ProductService } from './product.service'
import { semanticValue, typedSpecificationRows, typedVariantLabel } from './typed-product-detail'

type PublicCategory = Awaited<ReturnType<CategoryPublicReadService['findAll']>>[number]

/**
 * Public product page across the catalogue transition (TD-0013, Plan-0010 F08/B08).
 *
 * The SKU is visible only when its category is in the public projection — an active product
 * category whose every ancestor is active — so a draft or archived branch hides its products
 * here exactly as it hides them from the catalogue. Draft SKUs stay 404 in the repository.
 * A v1 category keeps the existing payload byte for byte; a v2 category answers the same shape
 * with values formatted from its definitions, so the storefront needs no second page.
 * `category_path` (root-first, ending with the product's own category) is additive on both.
 */
@Injectable()
export class PublicProductService {
	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly variants: ProductVariantRepository,
		private readonly categories: CategoryPublicReadService,
		private readonly products: ProductService
	) {}

	async bySlug(slug: string) {
		const result = await this.variants.findVariantWithProduct(slug)
		if (!result) throw new NotFoundException('Variant not found')
		// By id from the shared tree read, not a scan of a fresh copy of every product category.
		const category = await this.categories.findVisibleById(result.typed.category_id)
		if (!category || category.kind !== 'product')
			throw new NotFoundException('Variant not found')
		const path = {
			category_path: [...category.ancestors, category].map(({ _id, name, slug }) => ({
				_id,
				name,
				slug
			})),
			// A path too long to embed (Plan-0010 D06.4): the category alone, marked — the
			// ancestors are read from GET /categories/:id/ancestors, never silently cut.
			...(category.ancestors_paged
				? { category_path_paged: true, category_path_total: category.ancestors_total! + 1 }
				: {})
		}
		if (category.attribute_contract_version !== 2)
			return { ...this.products.legacyDetail(result, category), ...path }
		return { ...(await this.typedDetail(result, category)), ...path }
	}

	private async typedDetail(
		{
			typed,
			...result
		}: NonNullable<Awaited<ReturnType<ProductVariantRepository['findVariantWithProduct']>>>,
		category: PublicCategory
	) {
		const definitions = category.attribute_definitions
		const axis = typed.variant_axis
			? (definitions.find(definition => definition.key === typed.variant_axis!.key) ?? null)
			: null
		// A colour axis stores the dictionary id; the page keeps the legacy colour object and
		// `v_value` so the swatches and «Чорний (Black)» read exactly as before. Any other axis is
		// never a colour (TD-0013 B08).
		const colorAxis = axis?.semantic === 'color'
		const shape = <T extends (typeof result.siblings)[number]>(row: T) =>
			colorAxis
				? row
				: {
						...row,
						v_value: typedVariantLabel(axis, typed.variant_values[row.id]),
						color: null
					}
		const variant = shape(result.variant)
		const colorLabel = variant.color
			? variant.color.name_uk === variant.color.name_en
				? variant.color.name_uk
				: `${variant.color.name_uk} (${variant.color.name_en})`
			: (variant.v_value ?? null)
		const typedFor = (variantId: string) => ({
			definitions,
			attributes_v2: typed.attributes_v2,
			variant_axis: typed.variant_axis,
			variant_value: typed.variant_values[variantId]
		})
		const specs = typedSpecificationRows({
			definitions,
			attributes_v2: typed.attributes_v2,
			variant_axis: typed.variant_axis,
			variant_value: typed.variant_values[result.variant.id],
			...(colorAxis ? { axis_label: colorLabel } : {})
		})
		return {
			variant,
			siblings: result.siblings.map(shape),
			product: {
				id: result.product.id,
				name: result.product.name,
				description: result.product.description as {
					html: string
					json: unknown
				} | null,
				// `semantic` drives `variesBy` of the page's ProductGroup (Plan-0010 F09): only a
				// colour/size/material axis is a supported variant property; `generic` is not.
				variant_type: axis
					? { key: axis.key, label: axis.label, semantic: axis.semantic }
					: null,
				attributes: specs,
				// A linked brand entity first; otherwise the characteristic marked `brand` — never a
				// label match (owner, 2026-11-05). Never the vendor, which is the supplier.
				manufacturer:
					(await this.brandName(typed.brand_id)) ??
					semanticValue(typedFor(result.variant.id), 'brand')
			},
			category_slug: category.slug,
			category_name: category.name,
			// Size and material for the structured data — the same rule and values the feed sends:
			// only a characteristic marked with that meaning, nothing guessed from keys or labels.
			semantic_values: {
				size: semanticValue(typedFor(result.variant.id), 'size'),
				material: semanticValue(typedFor(result.variant.id), 'material')
			},
			// The product's own notice above the buy button (owner, 2026-11-05), always present for
			// v2 — null means none, and the page never falls back to built-in filament notes.
			attribute_notice: typed.purchase_notice
		}
	}

	private async brandName(id: string | null) {
		if (!id || !mongo.ObjectId.isValid(id)) return null
		const brand = await this.connection
			.collection('brands')
			.findOne(
				{ _id: new mongo.ObjectId(id), status: 'active' },
				{ projection: { name: 1 }, readPreference: 'primary' }
			)
		return typeof brand?.name === 'string' ? brand.name : null
	}
}
