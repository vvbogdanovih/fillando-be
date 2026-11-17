import {
	ConflictException,
	Controller,
	Get,
	Header,
	Injectable,
	Module,
	Query,
	UseGuards
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import {
	ApiConflictResponse,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiPropertyOptional,
	ApiResponse,
	ApiServiceUnavailableResponse,
	ApiTags
} from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import { ENDPOINTS, API_OPERATION } from 'src/common/constants'
import { ProductStatus, LandingStatus } from 'src/common/types/enums'
import { LegacyCatalogWritePolicy } from './legacy-catalog-write.interceptor'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { PublicCatalogService } from '../product/public-catalog.service'
import { ProductModule } from '../product/product.module'
import { collectionWriteMark } from '../category/category-fingerprint'

export class SitemapSlugDto {
	@ApiProperty() slug!: string
	@ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
	updatedAt?: Date | null
}
export class SitemapLandingDto extends SitemapSlugDto {
	@ApiProperty() category_slug!: string
}
export class CatalogSitemapDto {
	@ApiProperty() initialized!: boolean
	@ApiProperty() revision!: number
	@ApiProperty() epoch!: number
	@ApiProperty({ type: [SitemapSlugDto] }) variants!: SitemapSlugDto[]
	@ApiProperty({ type: [SitemapSlugDto] }) categories!: SitemapSlugDto[]
	@ApiProperty({ type: [SitemapLandingDto] }) landings!: SitemapLandingDto[]
}
export class SitemapPartDto {
	@ApiProperty({
		type: String,
		nullable: true,
		description:
			'First SKU slug of the part (inclusive); null — the first part, which also carries every category and landing'
	})
	from!: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'First SKU slug of the next part (exclusive); null — to the end'
	})
	to!: string | null
	@ApiProperty({ description: 'URLs of the part (SKUs, categories, landings)' }) urls!: number
}
export class CatalogSitemapIndexDto {
	@ApiProperty() initialized!: boolean
	@ApiProperty() revision!: number
	@ApiProperty() epoch!: number
	@ApiProperty({ type: [SitemapPartDto] }) parts!: SitemapPartDto[]
}
export class CatalogSitemapPartQueryDto {
	@ApiProperty({ description: '`revision` of the index the part belongs to' })
	@Type(() => Number)
	@IsInt()
	@Min(0)
	revision!: number
	@ApiProperty({ description: '`epoch` of the index the part belongs to' })
	@Type(() => Number)
	@IsInt()
	@Min(0)
	epoch!: number
	@ApiPropertyOptional({ description: '`from` of the part; absent for the first part' })
	@IsOptional()
	@IsString()
	@MinLength(1)
	@MaxLength(512)
	from?: string
	@ApiPropertyOptional({ description: '`to` of the part; absent for the last part' })
	@IsOptional()
	@IsString()
	@MinLength(1)
	@MaxLength(512)
	to?: string
}
/**
 * Part size: Google takes ≤ 50 000 URLs per sitemap file and TD-0013 §6 caps every API payload at
 * 2 MiB. The index plans parts below both with headroom — the storefront adds its static pages
 * and `/catalog` to the first file, and SKUs created inside a part's slug range between the index
 * and the part read (no revision change, e.g. before the catalogue is initialised) land in it.
 */
export const SITEMAP_PART_PLAN = { urls: 45_000, bytes: 1.5 * 1024 * 1024 }
export const SITEMAP_PART_LIMIT = { urls: 50_000, bytes: 2 * 1024 * 1024 }
/** A built URL set is kept at most this long, whatever the write marks say (P14). */
export const SITEMAP_MEMO_MS = 10 * 60_000
/** The collections the URL set is read from: a write to any of them is a new set. */
const SITEMAP_SOURCES = ['categories', 'products', 'product_variants', 'landings'] as const
type UrlSet = {
	categories: SitemapSlugDto[]
	landings: SitemapLandingDto[]
	variants: SitemapSlugDto[]
}
/** A public landing as the sitemap reads it, with what its count needs. */
type LandingRow = SitemapLandingDto & {
	_category: string
	_typed: boolean
	_id_text: string
	_category_id: mongo.ObjectId
	_filters?: unknown
	_filters_v2?: unknown
}

@Injectable()
export class CatalogSitemapService {
	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly policy: LegacyCatalogWritePolicy,
		private readonly categories: CategoryPublicReadService,
		private readonly catalog: PublicCatalogService,
		private readonly variantRepository: ProductVariantRepository
	) {}
	private memo: { key: string; at: number; set: Promise<UrlSet> } | null = null
	/**
	 * The parts of one URL set under one read stamp, restricted to the public tree (TD-0013 SEO
	 * matrix): SKUs of visible product categories, visible categories/groups that hold at least
	 * one active SKU somewhere below them (a known empty listing is noindex and stays out), and
	 * landings of visible v1 categories and typed (`filters_v2`) landings of visible v2 ones.
	 *
	 * The first part carries every category and landing and the first SKUs by slug; the rest are
	 * consecutive slug ranges, cut before `SITEMAP_PART_PLAN` is reached. A part is a slug range,
	 * not an offset, so a SKU added between this read and a part read lands in exactly one part.
	 * On the current catalogue (and anything below ~20 000 URLs) there is one part.
	 */
	async index(): Promise<CatalogSitemapIndexDto> {
		const stamp = await this.policy.beginRead(true)
		const { categories, landings, variants } = await this.urlSet(stamp)
		const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
		const empty = { ...stamp, variants: [], categories: [], landings: [] }
		const parts: SitemapPartDto[] = []
		let current = {
			from: null as string | null,
			urls: categories.length + landings.length,
			bytes: bytes({ ...empty, categories, landings })
		}
		for (const variant of variants) {
			// One entry and its comma, exactly as the part serialises it.
			const size = bytes(variant) + 1
			if (
				current.urls > 0 &&
				(current.urls + 1 > SITEMAP_PART_PLAN.urls ||
					current.bytes + size > SITEMAP_PART_PLAN.bytes)
			) {
				parts.push({ from: current.from, to: variant.slug, urls: current.urls })
				current = { from: variant.slug, urls: 0, bytes: bytes(empty) }
			}
			current.urls++
			current.bytes += size
		}
		parts.push({ from: current.from, to: null, urls: current.urls })
		await this.policy.finishRead(stamp, true)
		return { ...stamp, parts }
	}
	/**
	 * One part of the index, read under the same revision/epoch the index was read under (409
	 * `SITEMAP_REVISION_CHANGED` otherwise: the caller re-reads the index, so a crawl never mixes
	 * two catalogue states) and the usual read barrier. A part grown past `SITEMAP_PART_LIMIT`
	 * since the index is 409 `SITEMAP_PART_TOO_LARGE` — re-read the index.
	 */
	async part(query: CatalogSitemapPartQueryDto): Promise<CatalogSitemapDto> {
		const stamp = await this.policy.beginRead(true)
		if (stamp.revision !== Number(query.revision) || stamp.epoch !== Number(query.epoch))
			throw new ConflictException({
				message: 'The catalogue changed since the sitemap index was read',
				details: {
					code: 'SITEMAP_REVISION_CHANGED',
					revision: stamp.revision,
					epoch: stamp.epoch
				}
			})
		const set = await this.urlSet(stamp)
		const first = query.from === undefined
		const pages = first
			? { categories: set.categories, landings: set.landings }
			: { categories: [], landings: [] }
		// The set is in slug order: the part is the range `[from, to)` of it.
		const variants = set.variants.filter(
			row =>
				(query.from === undefined || row.slug >= query.from) &&
				(query.to === undefined || row.slug < query.to)
		)
		await this.policy.finishRead(stamp, true)
		const result = { ...stamp, variants, ...pages }
		if (
			variants.length + pages.categories.length + pages.landings.length >
				SITEMAP_PART_LIMIT.urls ||
			Buffer.byteLength(JSON.stringify(result)) > SITEMAP_PART_LIMIT.bytes
		)
			throw new ConflictException({
				message: 'The sitemap part outgrew its limits; read the index again',
				details: { code: 'SITEMAP_PART_TOO_LARGE' }
			})
		return result
	}
	/**
	 * The URL set of one catalogue state, built once (P14, owner decision 02.11.2026): kept while
	 * the read stamp (revision, epoch) and the write marks of its source collections are the same,
	 * so a crawler reading the index and every part — or several crawlers — no longer walk every
	 * SKU each time. A mark changes with any write (a Prom sync without a revision too) and with a
	 * collection dropped and restored; without marks (a server that does not report them) nothing
	 * is kept, and `SITEMAP_MEMO_MS` bounds it in any case. The marks are read before the data.
	 */
	private async urlSet(stamp: { initialized: boolean; revision: number; epoch: number }) {
		const key = await this.memoKey(stamp)
		const memo = this.memo
		if (key && memo && memo.key === key && Date.now() - memo.at < SITEMAP_MEMO_MS)
			return memo.set
		const set = this.build()
		if (key) {
			const entry = { key, at: Date.now(), set }
			this.memo = entry
			set.catch(() => {
				if (this.memo === entry) this.memo = null
			})
		}
		return set
	}
	/**
	 * What the built set is kept under, or `null` when the state cannot be told — then nothing is
	 * kept and every read builds. Keeping the set is an optimisation: no failure here may fail the
	 * export.
	 *
	 * The collections are listed without a filter and matched here. Atlas refuses a
	 * `listCollections` filter a plain `mongod` accepts: `{ name: { $in: [...] } }` answered
	 * `MongoServerError 8000: can't get regex from filter doc not a regex`, and
	 * `GET /catalog/sitemap` was a 500 in production right after the deploy of 17.11.2026 while
	 * every local run and test passed.
	 */
	private async memoKey(stamp: { initialized: boolean; revision: number; epoch: number }) {
		try {
			const existing = new Set(
				(await this.connection.db!.listCollections({}, { nameOnly: true }).toArray()).map(
					row => row.name
				)
			)
			// A collection not created yet is a known state; an existing one without a mark is not.
			const marks = await Promise.all(
				SITEMAP_SOURCES.map(name =>
					existing.has(name)
						? collectionWriteMark(this.connection, name)
						: Promise.resolve('absent')
				)
			)
			return marks.every(Boolean)
				? JSON.stringify([stamp.initialized, stamp.revision, stamp.epoch, marks])
				: null
		} catch {
			return null
		}
	}
	private async build(): Promise<UrlSet> {
		const scope = await this.scope()
		const [pages, variants] = await Promise.all([
			this.pages(scope),
			(async () => {
				const rows: SitemapSlugDto[] = []
				for await (const row of this.variants(scope.productIds)) rows.push(row)
				return rows
			})()
		])
		return { ...pages, variants }
	}
	/**
	 * The visible tree and its product categories as id strings. No `$in` of every visible id
	 * (Plan-0010 D06): at 150 000 categories those arrays — ~600 000 ObjectIds per index — ran a
	 * 400 MB heap out of memory; the queries below filter by the same set here instead.
	 */
	private async scope() {
		const tree = await this.categories.findVisibleTree()
		const products = tree.filter(node => node.kind === 'product')
		return { tree, products, productIds: new Set(products.map(node => node._id)) }
	}
	/**
	 * Active SKUs of visible product categories by slug — read by slug and kept when their
	 * category is visible, in the same order and shape as a `$in` query.
	 */
	private async *variants(productIds: Set<string>): AsyncGenerator<SitemapSlugDto> {
		const cursor = this.connection
			.db!.collection('product_variants')
			.find<SitemapSlugDto & { category_id?: mongo.ObjectId }>(
				{ status: ProductStatus.ACTIVE },
				{
					projection: { _id: 0, slug: 1, updatedAt: 1, category_id: 1 },
					readPreference: 'primary'
				}
			)
			.sort({ slug: 1 })
		for await (const row of cursor) {
			if (!row.category_id || !productIds.has(String(row.category_id))) continue
			delete row.category_id
			yield row
		}
	}
	/** The non-empty visible categories and the public landings — all in the first part. */
	private async pages({
		tree,
		products,
		productIds
	}: Awaited<ReturnType<CatalogSitemapService['scope']>>) {
		const db = this.connection.db!
		// Landings of visible categories by contract (a v2 category's only with typed pins),
		// matched here against the id sets rather than by a `$in` of every visible id.
		const versionOf = new Map(products.map(node => [node._id, node.attribute_contract_version]))
		const [counts, allLandings] = await Promise.all([
			// Categories with an active SKU, every category; the visible ones are kept below.
			db
				.collection('product_variants')
				.aggregate<{ _id: mongo.ObjectId | null }>(
					[
						{ $match: { status: ProductStatus.ACTIVE } },
						{ $group: { _id: '$category_id' } }
					],
					{ readPreference: 'primary' }
				)
				.toArray(),
			db
				.collection('landings')
				.aggregate<LandingRow>(
					[
						{ $match: { status: LandingStatus.ACTIVE } },
						{
							$lookup: {
								from: 'categories',
								localField: 'category_id',
								foreignField: '_id',
								as: 'category'
							}
						},
						{ $unwind: '$category' },
						{
							$project: {
								_id: 0,
								slug: 1,
								updatedAt: 1,
								category_slug: '$category.slug',
								_id_text: { $toString: '$_id' },
								_category_id: '$category_id',
								_filters: '$filters',
								_filters_v2: '$filters_v2',
								_category: { $toString: '$category_id' },
								_typed: {
									$and: [
										{ $eq: ['$contract_version', 2] },
										{ $eq: [{ $type: '$filters_v2' }, 'object'] }
									]
								}
							}
						},
						{ $sort: { category_slug: 1, slug: 1 } }
					],
					{ readPreference: 'primary' }
				)
				.toArray()
		])
		const publicLandings = allLandings.filter(row => {
			const version = versionOf.get(String(row._category))
			return version === 1 || (version === 2 && row._typed)
		})
		// A published landing whose pins match no active SKU is a known empty listing — noindex,
		// so not in the sitemap (P02; SEO matrix «Відомі порожні»), counted as its page counts.
		const landingSkus = await this.landingCounts(publicLandings)
		const landings = publicLandings.flatMap(row => {
			if (!landingSkus.get(row._id_text)) return []
			const { _category, _typed, _id_text, _category_id, _filters, _filters_v2, ...landing } =
				row
			void [_category, _typed, _id_text, _category_id, _filters, _filters_v2]
			return [landing]
		})
		const filled = new Set(counts.map(row => String(row._id)))
		const nonEmpty = new Set<string>()
		const byId = new Map(tree.map(node => [node._id, node]))
		for (const node of products)
			if (productIds.has(node._id) && filled.has(node._id))
				// The category and every ancestor up to the root (the tree carries no content).
				for (
					let id: string | null = node._id;
					id !== null && !nonEmpty.has(id);
					id = byId.get(id)?.parent_id ?? null
				)
					nonEmpty.add(id)
		// `updatedAt` of just the categories the sitemap lists.
		const updated = await db
			.collection('categories')
			.find(
				{ _id: { $in: [...nonEmpty].map(id => new mongo.ObjectId(id)) } },
				{ projection: { _id: 1, updatedAt: 1 }, readPreference: 'primary' }
			)
			.toArray()
		const updatedAt = new Map(
			updated.map(row => [String(row._id), (row.updatedAt as Date | undefined) ?? null])
		)
		const categories = tree
			.filter(node => nonEmpty.has(node._id))
			.map(node => ({
				slug: node.slug,
				...(updatedAt.get(node._id) ? { updatedAt: updatedAt.get(node._id) } : {})
			}))
			.sort((a, b) => a.slug.localeCompare(b.slug))
		return { categories: categories as SitemapSlugDto[], landings }
	}

	/** Active SKUs of each landing: a typed one by its category's definitions, a legacy one by its pins. */
	private async landingCounts(rows: LandingRow[]) {
		const counts = new Map<string, number>()
		const typed = new Map<string, { id: string; filters: unknown }[]>()
		const legacy: {
			id: string
			category_id: mongo.ObjectId
			filters: Record<string, string[]>
		}[] = []
		for (const row of rows)
			if (row._typed)
				typed
					.set(row._category, typed.get(row._category) ?? [])
					.get(row._category)!
					.push({ id: row._id_text, filters: row._filters_v2 })
			else
				legacy.push({
					id: row._id_text,
					category_id: row._category_id,
					filters: (row._filters ?? {}) as Record<string, string[]>
				})
		for (const [categoryId, items] of typed)
			for (const [id, count] of await this.catalog.countTypedLandings(categoryId, items))
				counts.set(id, count)
		for (const [id, count] of await this.variantRepository.countVariantsForLandings(legacy))
			counts.set(id, count)
		return counts
	}
}
/**
 * Every read scans the SKUs of the visible tree. The storefront reads it with the internal token
 * (exempt); anyone else gets a modest per-IP limit (owner decision 31.10.2026). Behind Cloudflare
 * the per-IP key is approximate until the real client IP is restored — a separate task. Keeping
 * the built sitemap in memory until the catalogue revision changes, as the feed does, is queued
 * after the release.
 */
const SITEMAP_THROTTLE = { default: { limit: 10, ttl: 60_000 } }

@ApiTags(ENDPOINTS.CATALOG_EXPORT.BASE)
@Controller(ENDPOINTS.CATALOG_EXPORT.BASE)
@UseGuards(ThrottlerGuard)
@Throttle(SITEMAP_THROTTLE)
@ApiResponse({
	status: 429,
	description: 'Over 10 requests a minute per IP without X-Internal-Token'
})
export class CatalogSitemapController {
	constructor(private readonly service: CatalogSitemapService) {}
	@Get(ENDPOINTS.CATALOG_EXPORT.SITEMAP)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATALOG_EXPORT.SITEMAP)
	@ApiOkResponse({ type: CatalogSitemapIndexDto })
	@ApiServiceUnavailableResponse({
		description:
			'Catalog maintenance, changed read stamp or incompatible legacy projection. Never returns a partial index.'
	})
	index() {
		return this.service.index()
	}
	@Get(ENDPOINTS.CATALOG_EXPORT.SITEMAP_PART)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATALOG_EXPORT.SITEMAP_PART)
	@ApiOkResponse({ type: CatalogSitemapDto })
	@ApiConflictResponse({
		description:
			'SITEMAP_REVISION_CHANGED — the catalogue changed since the index; SITEMAP_PART_TOO_LARGE — the part outgrew its limits. Re-read the index.'
	})
	@ApiServiceUnavailableResponse({
		description:
			'Catalog maintenance, changed read stamp or incompatible legacy projection. Never returns a partial export.'
	})
	part(@Query() query: CatalogSitemapPartQueryDto) {
		return this.service.part(query)
	}
}
@Module({
	imports: [ProductModule],
	controllers: [CatalogSitemapController],
	providers: [CatalogSitemapService, LegacyCatalogWritePolicy, CategoryPublicReadService]
})
export class CatalogSitemapModule {}
