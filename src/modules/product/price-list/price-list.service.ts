import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	Optional
} from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { PageOrientation } from 'src/common/types/enums'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { GeneratePriceListDto } from '../dto/generate-price-list.dto'
import {
	MANUFACTURER_PATTERNS,
	pickAttr,
	pickColor,
	pickVariantLabel
} from '../product-attribute.helpers'
import { CategoryPublicReadService } from '../../category/category-public-read.service'
import { isTypedCategory, legacyShapeOf, type LegacyShapeCategory } from '../typed-legacy-shape'
import { priceColumnsOf, priceValuesOf } from '../price-columns'
import { formatColorLabel } from '../product.service'
import { PriceListPdfProvider } from './price-list-pdf.provider'
import { priceListTemplate } from './price-list.template'
import type { PriceListBlock, PriceListRawRow, PriceListSection } from './price-list.types'

/**
 * Beyond this the container OOMs instead of returning an error, so the cap IS the
 * protection. ~20k rows is roughly 400 A4 pages.
 */
const MAX_ROWS = 20_000

/**
 * A merged `rowspan` cell that crosses a page break renders unreliably in Chromium
 * (text or the bottom border goes missing). So every product group is sliced into
 * blocks small enough to always fit one page, and each block is a `<tbody>` marked
 * `break-inside: avoid`. Do not "simplify" this away — see src/docs/PRICE_LIST_PDF.md.
 *
 * At 9px a page fits ~55 rows portrait and ~37 landscape (the shorter page), so 16 fits
 * either way. One value for both orientations is deliberate: a smaller landscape block was
 * measured and barely moved the trailing gap (a block moving down whole leaves ~18% of the
 * page empty either way), while it did add a "(продовження)" split to ordinary 12-16 colour
 * products. The gap is inherent to `break-inside: avoid`; the spurious split is not.
 */
const MAX_ROWS_PER_BLOCK = 16

const LOGO_PATH = '/Fillando-logo.png'

/** Must stay in sync with `.logo { height }` in price-list.template.ts. */
const LOGO_RENDER_HEIGHT_PX = 26

@Injectable()
export class PriceListService {
	private readonly logger = new Logger(PriceListService.name)
	private readonly collator = new Intl.Collator('uk-UA', { sensitivity: 'base', numeric: true })

	/** Each run forks a Chromium; two concurrent runs are enough to OOM the container. */
	private generating = false
	private logoDataUri: string | null = null
	private logoFetched = false

	constructor(
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly categoryRepository: CategoryRepository,
		private readonly priceListPdfProvider: PriceListPdfProvider,
		/**
		 * Public category projection (TD-0013). With it the PDF lists only SKUs of publicly
		 * visible product categories and formats v2 products from their definitions; without it
		 * (callers predating the tree) every category is read as before.
		 */
		@Optional() private readonly publicCategories?: CategoryPublicReadService
	) {}

	async generatePdf(dto: GeneratePriceListDto): Promise<{ buffer: Buffer; filename: string }> {
		if (this.generating) {
			throw new ConflictException('Прайс-лист уже генерується, спробуйте через хвилину')
		}
		this.generating = true

		try {
			const inStockOnly = dto.in_stock_only ?? false
			const landscape =
				(dto.orientation ?? PageOrientation.PORTRAIT) === PageOrientation.LANDSCAPE

			// Visible categories without content (Plan-0010 D06); definitions only for the rows'.
			const visible = this.publicCategories
				? await this.publicCategories.productCategories()
				: null
			const byId = new Map((visible ?? []).map(category => [category._id, category]))
			// A requested category that is not public contributes nothing, exactly like one
			// without active SKUs; an empty selection means every visible category.
			const requested = dto.category_ids?.map(id => id.toLowerCase()) ?? []
			const categoryIds = visible
				? requested.length
					? requested.filter(id => byId.has(id))
					: [...byId.keys()]
				: dto.category_ids
			const rows =
				visible && categoryIds!.length === 0
					? []
					: await this.productVariantRepository.findPriceListRows({
							categoryIds,
							inStockOnly,
							limit: MAX_ROWS + 1
						})
			const content: Map<string, LegacyShapeCategory & { name?: string }> = visible
				? await this.publicCategories!.contentOf(
						rows.map(row => row.category_id ?? ''),
						{ of: visible, cache: false }
					)
				: new Map<string, LegacyShapeCategory & { name?: string }>()
			const raw = rows.map(row => this.adaptRow(row, content.get(row.category_id ?? '')))
			// Sections in catalogue order; without the public projection, by name.
			const order = new Map((visible ?? []).map((category, index) => [category._id, index]))

			if (raw.length === 0) {
				throw new BadRequestException('Немає товарів за обраними фільтрами')
			}
			if (raw.length > MAX_ROWS) {
				throw new BadRequestException(
					`Занадто багато позицій (понад ${MAX_ROWS}). Оберіть менше категорій.`
				)
			}

			const [categoryNames, logoDataUri] = await Promise.all([
				visible
					? requested
							.flatMap(id => byId.get(id)?.name ?? [])
							.sort((a, b) => this.collator.compare(a, b))
					: this.resolveCategoryNames(dto.category_ids),
				this.resolveLogo()
			])

			const html = priceListTemplate({
				generatedAt: new Date(),
				landscape,
				inStockOnly,
				categoryNames,
				totalRows: raw.length,
				logoDataUri,
				sections: await this.buildSections(raw, content, order)
			})

			const buffer = await this.priceListPdfProvider.generatePdf(
				html,
				'Fillando — Прайс-лист',
				landscape
			)
			const filename = `price-list-${new Date().toISOString().slice(0, 10)}.pdf`

			this.logger.log(`Price list generated: ${raw.length} rows, ${buffer.length} bytes`)
			return { buffer, filename }
		} finally {
			this.generating = false
		}
	}

	/**
	 * A v2 row in the legacy shape the grouping reads (TD-0013): characteristics formatted
	 * from the definitions, the brand named explicitly (a linked brand entity or the
	 * characteristic marked `brand`) and a non-colour axis value as its label («63 А»). A v1
	 * row is unchanged.
	 */
	private adaptRow(row: PriceListRawRow, category?: LegacyShapeCategory): PriceListRawRow {
		if (!isTypedCategory(category)) return row
		const shape = legacyShapeOf(category, {
			attributes_v2: row.attributes_v2,
			variant_axis: row.variant_axis,
			variant_value: row.variant_value,
			v_value: row.v_value,
			brand_name: row.brand_name
		})
		return {
			...row,
			brand: shape.manufacturer,
			attributes: shape.attributes,
			variant_type: shape.variant && { key: shape.variant.key, label: shape.variant.label },
			v_value: shape.variant?.value ?? null
		}
	}

	/**
	 * One section per category (owner, 2026-11-06): its own columns — what the catalogue filters it
	 * by — and its products in page-safe blocks. Categories come in catalogue order; a category the
	 * public projection does not describe (callers predating the tree) is named from the database.
	 */
	private async buildSections(
		raw: PriceListRawRow[],
		content: Map<string, LegacyShapeCategory & { name?: string }>,
		order: Map<string, number>
	): Promise<PriceListSection[]> {
		const byCategory = new Map<string, PriceListRawRow[]>()
		for (const row of raw) {
			const id = row.category_id ?? ''
			const bucket = byCategory.get(id)
			if (bucket) bucket.push(row)
			else byCategory.set(id, [row])
		}
		const unnamed = [...byCategory.keys()].filter(id => !content.get(id)?.name)
		const names = new Map(
			unnamed.length
				? (await this.categoryRepository.findAll({ _id: { $in: unnamed } })).map(row => [
						// Lean documents: the schema type does not declare `_id`.
						String((row as { _id?: unknown })._id),
						row.name
					])
				: []
		)
		const sections = [...byCategory].map(([id, rows]) => {
			const category = content.get(id)
			const columns = priceColumnsOf(category)
			const blocks = this.buildBlocks(rows, category)
			return {
				id,
				section: {
					category_name: category?.name ?? names.get(id) ?? '',
					columns,
					// A v1 category has no columns; a typed product whose axis is not one of them
					// would otherwise show identical rows.
					variant_column:
						!columns.length ||
						blocks.some(
							block =>
								block.axis_key !== null &&
								!columns.some(column => column.key === block.axis_key)
						),
					blocks
				}
			}
		})
		sections.sort(
			(a, b) =>
				(order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) ||
				this.collator.compare(a.section.category_name, b.section.category_name)
		)
		return sections.map(row => row.section)
	}

	/**
	 * Groups one category's variants by product, orders brand → product → variant, and slices
	 * each group into page-safe blocks. Ordering happens here rather than in the aggregation
	 * because a v1 brand is a regex match on a human-entered attribute label, and because
	 * Mongo's default collation is binary (it would sort `Ю` before `а`).
	 */
	private buildBlocks(
		raw: PriceListRawRow[],
		category: LegacyShapeCategory | undefined
	): PriceListBlock[] {
		const groups = new Map<string, PriceListRawRow[]>()
		for (const row of raw) {
			// Keyed by id, not name — two distinct products may share a name and must not merge.
			const bucket = groups.get(row.product_id)
			if (bucket) bucket.push(row)
			else groups.set(row.product_id, [row])
		}

		const decorated = [...groups.values()].map(rows => ({
			rows,
			// Same product ⇒ same attributes, so the first row carries the brand: named on a v2
			// row, the «Виробник» label match on a v1 one until the last v1 category is migrated.
			brand:
				rows[0].brand !== undefined
					? rows[0].brand
					: pickAttr(rows[0].attributes ?? [], MANUFACTURER_PATTERNS),
			name: rows[0].product_name
		}))

		decorated.sort((a, b) => {
			// Products with no brand attribute go last.
			if (a.brand && !b.brand) return -1
			if (!a.brand && b.brand) return 1
			if (a.brand && b.brand) {
				const byBrand = this.collator.compare(a.brand, b.brand)
				if (byBrand !== 0) return byBrand
			}
			return this.collator.compare(a.name, b.name)
		})

		const blocks: PriceListBlock[] = []
		for (const group of decorated) {
			const rows = [...group.rows].sort(
				(x, y) =>
					this.collator.compare(
						this.variantLabelOf(x) ?? '',
						this.variantLabelOf(y) ?? ''
					) || this.collator.compare(x.sku, y.sku)
			)

			// Split evenly rather than greedily, so 17 variants become 9 + 8 instead of
			// 16 + 1 — a lone trailing row under its own repeated name reads as a glitch.
			const blockCount = Math.ceil(rows.length / MAX_ROWS_PER_BLOCK)
			const perBlock = Math.ceil(rows.length / blockCount)

			for (let i = 0; i < rows.length; i += perBlock) {
				const slice = rows.slice(i, i + perBlock)
				blocks.push({
					product_name: group.name,
					is_continuation: i > 0,
					axis_key: isTypedCategory(category)
						? (group.rows[0].variant_axis?.key ?? null)
						: null,
					rows: slice.map(variant => ({
						sku: variant.sku,
						variant_label: this.variantLabelOf(variant) ?? '—',
						values: priceValuesOf(category, {
							...variant,
							color_label: formatColorLabel(
								variant.color_name_uk,
								variant.color_name_en
							)
						}),
						stock: variant.stock ?? 0,
						price: variant.price
					}))
				})
			}
		}

		return blocks
	}

	private variantLabelOf(row: PriceListRawRow): string | null {
		const prefix = `${row.product_name} — `
		if (row.variant_name.startsWith(prefix))
			return row.variant_name.slice(prefix.length).trim() || null
		return pickVariantLabel(
			row.v_value,
			row.variant_type,
			pickColor(row.v_value, row.attributes ?? [], row.variant_type)
		)
	}

	private async resolveCategoryNames(categoryIds?: string[]): Promise<string[]> {
		if (!categoryIds || categoryIds.length === 0) return []
		const categories = await this.categoryRepository.findAll({ _id: { $in: categoryIds } })
		return categories.map(category => category.name).sort((a, b) => this.collator.compare(a, b))
	}

	/**
	 * The logo lives in the frontend's public dir; the backend image ships no assets and
	 * nest-cli.json copies none. Fetched once and inlined as a data URI rather than left
	 * as a remote `<img>`, because `waitUntil: 'load'` would hang if the frontend were
	 * unreachable. Failure is non-fatal — the template falls back to a text wordmark.
	 */
	private async resolveLogo(): Promise<string | null> {
		if (this.logoFetched) return this.logoDataUri
		this.logoFetched = true

		try {
			const response = await fetch(`${ENV.FRONTEND_URL}${LOGO_PATH}`)
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			// The source PNG is 2199x518 / ~285KB and would dominate the PDF size, so it is
			// downscaled to twice its rendered height (26px) for a crisp print result.
			const sharp = (await import('sharp')).default
			const resized = await sharp(Buffer.from(await response.arrayBuffer()))
				.resize({ height: LOGO_RENDER_HEIGHT_PX * 2, withoutEnlargement: true })
				.png({ compressionLevel: 9 })
				.toBuffer()
			this.logoDataUri = `data:image/png;base64,${resized.toString('base64')}`
		} catch (error) {
			this.logger.warn(
				`Could not fetch price list logo, falling back to wordmark: ${String(error)}`
			)
			this.logoDataUri = null
		}

		return this.logoDataUri
	}
}
