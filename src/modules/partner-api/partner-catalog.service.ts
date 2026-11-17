import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { Types } from 'mongoose'
import { ENV } from 'src/common/constants'
import {
	PartnerCatalogRepository,
	PartnerCatalogRow
} from 'src/database/mongoose/repositories/partner-catalog.repository'
import { PartnerProductDto, PartnerSkuRequestDto, PartnerSkuPageDto } from './partner-catalog.dto'
import { salePriceOf } from 'src/modules/product/promo-pricing'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import {
	isTypedCategory,
	legacyShapeOf,
	withAxisColourRow,
	type LegacyShapeCategory
} from '../product/typed-legacy-shape'

/**
 * Partner catalogue (dealer integrations). The v1 payload is a frozen contract: across the
 * catalogue transition (TD-0013) only the publicly visible product categories and their SKUs
 * are exported, and a v2 product answers in the same shape through `legacyShapeOf`.
 */
@Injectable()
export class PartnerCatalogService {
	constructor(
		private readonly repository: PartnerCatalogRepository,
		/**
		 * Public category projection. With it this is an adapted reader; without it (callers
		 * predating the tree) every category is exported as before.
		 */
		@Optional() private readonly publicCategories?: CategoryPublicReadService
	) {}
	/** Visible product categories without content (Plan-0010 D06): which ids are public. */
	private async visible() {
		if (!this.publicCategories) return null
		const categories = await this.publicCategories.productCategories()
		return {
			categories,
			byId: new Map(categories.map(row => [row._id, row])),
			ids: categories.map(row => new Types.ObjectId(row._id))
		}
	}
	async categories() {
		// Product categories only, flat, as the contract promises (`parent_id` stays null): a
		// group holds no SKUs and nested product categories are listed by themselves.
		return this.repository.categories((await this.visible())?.ids)
	}
	async skus(query: PartnerSkuRequestDto): Promise<PartnerSkuPageDto> {
		const categoryId = query.category_id?.toLowerCase()
		const after = query.cursor ? this.decodeCursor(query.cursor, categoryId) : undefined
		const visible = await this.visible()
		if (
			categoryId &&
			(visible
				? !visible.byId.has(categoryId)
				: !(await this.repository.categoryExists(categoryId)))
		)
			throw new NotFoundException('Category not found')
		const rows = await this.repository.skus(categoryId, after, query.limit, visible?.ids)
		const items = rows.slice(0, query.limit).map(row => row.sku)
		return {
			items,
			next_cursor:
				rows.length > query.limit
					? Buffer.from(
							JSON.stringify({
								v: 1,
								sku: items[items.length - 1],
								category_id: categoryId ?? null
							})
						).toString('base64url')
					: null
		}
	}
	private decodeCursor(cursor: string, categoryId?: string): string {
		try {
			if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
			const buffer = Buffer.from(cursor, 'base64url')
			if (buffer.toString('base64url') !== cursor) throw new Error()
			const value: unknown = JSON.parse(buffer.toString('utf8'))
			if (
				!value ||
				typeof value !== 'object' ||
				!('v' in value) ||
				value.v !== 1 ||
				!('sku' in value) ||
				typeof value.sku !== 'string' ||
				!value.sku.length ||
				value.sku.length > 100 ||
				!('category_id' in value) ||
				value.category_id !== (categoryId ?? null)
			)
				throw new Error()
			return value.sku
		} catch {
			throw new BadRequestException('Invalid cursor for this category')
		}
	}
	async lookup(skus: string[]) {
		const unique = [...new Set(skus)]
		const visible = await this.visible()
		const rows = await this.repository.lookup(unique, visible?.ids)
		// The definitions of just the categories these SKUs are in, against the same tree.
		const content: Map<string, LegacyShapeCategory> | undefined = visible
			? await this.publicCategories!.contentOf(
					rows.map(row => row.category._id.toString()),
					{ of: visible.categories }
				)
			: undefined
		const bySku = new Map(rows.map(row => [row.sku, row]))
		const items: PartnerProductDto[] = []
		const not_found: string[] = []
		const now = new Date()
		for (const sku of unique) {
			const row = bySku.get(sku)
			if (row) items.push(this.toProduct(row, now, content?.get(row.category._id.toString())))
			else not_found.push(sku)
		}
		return { items, not_found }
	}
	private toProduct(
		row: PartnerCatalogRow,
		now: Date = new Date(),
		category?: LegacyShapeCategory
	): PartnerProductDto {
		const quantity = Number.isFinite(row.stock) ? Math.max(0, row.stock) : 0
		const typed = isTypedCategory(category)
			? legacyShapeOf(category, {
					attributes_v2: row.product.attributes_v2,
					variant_axis: row.product.variant_axis,
					variant_value: row.variant_value,
					v_value: row.v_value,
					brand_name: row.product.brand_name
				})
			: null
		return {
			sku: row.sku,
			name: row.name,
			price: row.price,
			// The shop's current promotion, if any (TD-0012) — the retail figure a shopper sees.
			sale_price: salePriceOf(row, now),
			currency: 'UAH',
			description_html: row.product.description?.html || null,
			category: {
				id: row.category._id.toString(),
				name: row.category.name,
				slug: row.category.slug
			},
			attributes: (typed && isTypedCategory(category)
				? withAxisColourRow(typed.attributes, category, {
						variant_axis: row.product.variant_axis,
						colour_name: row.color_name_uk,
						legacy_attributes: row.product.attributes
					})
				: (row.product.attributes ?? [])
			).map(a => ({
				key: a.k,
				label: a.l,
				value: a.v
			})),
			variant: typed
				? typed.variant
				: row.product.variant_type && row.v_value != null
					? {
							key: row.product.variant_type.key,
							label: row.product.variant_type.label,
							value: row.v_value
						}
					: null,
			images: row.images ?? [],
			url: ENV.FRONTEND_URL.replace(/\/$/, '') + '/products/' + encodeURIComponent(row.slug),
			weight_g:
				typeof row.weight_g === 'number' &&
				Number.isFinite(row.weight_g) &&
				row.weight_g > 0
					? row.weight_g
					: null,
			availability: {
				sku: row.sku,
				in_stock: quantity > 0,
				quantity,
				stock_updated_at: row.stock_updated_at?.toISOString() ?? null
			}
		}
	}
}
