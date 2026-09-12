import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import {
	PartnerCatalogRepository,
	PartnerCatalogRow
} from 'src/database/mongoose/repositories/partner-catalog.repository'
import { PartnerProductDto, PartnerSkuRequestDto, PartnerSkuPageDto } from './partner-catalog.dto'

@Injectable()
export class PartnerCatalogService {
	constructor(private readonly repository: PartnerCatalogRepository) {}
	categories() {
		return this.repository.categories()
	}
	async skus(query: PartnerSkuRequestDto): Promise<PartnerSkuPageDto> {
		const categoryId = query.category_id?.toLowerCase()
		const after = query.cursor ? this.decodeCursor(query.cursor, categoryId) : undefined
		if (categoryId && !(await this.repository.categoryExists(categoryId)))
			throw new NotFoundException('Category not found')
		const rows = await this.repository.skus(categoryId, after, query.limit)
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
		const rows = await this.repository.lookup(unique)
		const bySku = new Map(rows.map(row => [row.sku, row]))
		const items: PartnerProductDto[] = []
		const not_found: string[] = []
		for (const sku of unique) {
			const row = bySku.get(sku)
			if (row) items.push(this.toProduct(row))
			else not_found.push(sku)
		}
		return { items, not_found }
	}
	private toProduct(row: PartnerCatalogRow): PartnerProductDto {
		const quantity = Number.isFinite(row.stock) ? Math.max(0, row.stock) : 0
		return {
			sku: row.sku,
			name: row.name,
			description_html: row.product.description?.html || null,
			category: {
				id: row.category._id.toString(),
				name: row.category.name,
				slug: row.category.slug
			},
			attributes: (row.product.attributes ?? []).map(a => ({
				key: a.k,
				label: a.l,
				value: a.v
			})),
			variant:
				row.product.variant_type && row.v_value != null
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
