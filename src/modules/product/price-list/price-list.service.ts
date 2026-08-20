import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common'
import { ENV } from 'src/common/constants'
import { PageOrientation } from 'src/common/types/enums'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { GeneratePriceListDto } from '../dto/generate-price-list.dto'
import { MANUFACTURER_PATTERNS, pickAttr, pickColor } from '../product-attribute.helpers'
import { PriceListPdfProvider } from './price-list-pdf.provider'
import { priceListTemplate } from './price-list.template'
import type { PriceListBlock, PriceListRawRow } from './price-list.types'

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
		private readonly priceListPdfProvider: PriceListPdfProvider
	) {}

	async generatePdf(dto: GeneratePriceListDto): Promise<{ buffer: Buffer; filename: string }> {
		if (this.generating) {
			throw new ConflictException('Прайс-лист уже генерується, спробуйте через хвилину')
		}
		this.generating = true

		try {
			const tier1 = dto.tier1_percent ?? 10
			const tier2 = dto.tier2_percent ?? 15
			const inStockOnly = dto.in_stock_only ?? false
			const landscape =
				(dto.orientation ?? PageOrientation.PORTRAIT) === PageOrientation.LANDSCAPE

			const raw = await this.productVariantRepository.findPriceListRows({
				categoryIds: dto.category_ids,
				inStockOnly,
				limit: MAX_ROWS + 1
			})

			if (raw.length === 0) {
				throw new BadRequestException('Немає товарів за обраними фільтрами')
			}
			if (raw.length > MAX_ROWS) {
				throw new BadRequestException(
					`Занадто багато позицій (понад ${MAX_ROWS}). Оберіть менше категорій.`
				)
			}

			const [categoryNames, logoDataUri] = await Promise.all([
				this.resolveCategoryNames(dto.category_ids),
				this.resolveLogo()
			])

			const html = priceListTemplate({
				generatedAt: new Date(),
				landscape,
				tier1Percent: tier1,
				tier2Percent: tier2,
				inStockOnly,
				categoryNames,
				totalRows: raw.length,
				logoDataUri,
				blocks: this.buildBlocks(raw, tier1, tier2)
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
	 * Groups variants by product, orders brand → product → colour, and slices each group
	 * into page-safe blocks. Ordering happens here rather than in the aggregation because
	 * the brand is a regex match on a human-entered attribute label, and because Mongo's
	 * default collation is binary (it would sort `Ю` before `а`).
	 */
	private buildBlocks(raw: PriceListRawRow[], tier1: number, tier2: number): PriceListBlock[] {
		const groups = new Map<string, PriceListRawRow[]>()
		for (const row of raw) {
			// Keyed by id, not name — two distinct products may share a name and must not merge.
			const bucket = groups.get(row.product_id)
			if (bucket) bucket.push(row)
			else groups.set(row.product_id, [row])
		}

		const decorated = [...groups.values()].map(rows => ({
			rows,
			// Same product ⇒ same attributes, so the first row carries the brand.
			brand: pickAttr(rows[0].attributes ?? [], MANUFACTURER_PATTERNS),
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
					this.collator.compare(this.colorOf(x) ?? '', this.colorOf(y) ?? '') ||
					this.collator.compare(x.sku, y.sku)
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
					rows: slice.map(variant => ({
						sku: variant.sku,
						color: this.colorOf(variant) ?? '—',
						stock: variant.stock ?? 0,
						price: variant.price,
						price_tier1: Math.round(variant.price * (1 - tier1 / 100)),
						price_tier2: Math.round(variant.price * (1 - tier2 / 100))
					}))
				})
			}
		}

		return blocks
	}

	private colorOf(row: PriceListRawRow): string | null {
		return pickColor(row.v_value, row.attributes ?? [], row.variant_type)
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
