import { createHash } from 'node:crypto'
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	Optional
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { categoryFingerprint } from '../category/category-fingerprint'
import { LegacyCatalogWritePolicy } from '../catalog-safety/legacy-catalog-write.interceptor'
import {
	parseCatalogFilters,
	parseCatalogStripQuery,
	parsePublicCatalogQuery,
	publicCatalogAttributes,
	type CatalogFilters
} from './public-catalog-query'
import type { AttributeDefinition } from '../category/attribute-definitions'
import { readCategoryConfiguration } from '../category/category-configuration'
import { effectivePriceExpr, publicPromoProjection, salePriceExpr } from './promo-pricing'
import { ProductService } from './product.service'
import { SearchProductsDto } from './dto/search-products.dto'
import { GetPriceSheetQueryDto } from './dto/get-price-sheet-query.dto'
import { ColorFamily } from 'src/common/types/enums'
import {
	pageSegments,
	slicePriced,
	variantWriteMark,
	withTies,
	type PageSegment,
	type PricedId
} from './catalog-listing-page'

type SwatchCandidate = { order?: number; name_en: string; hex_stops?: string[] }

/**
 * One row per family of the scope: the self-excluding count (zero kept) and the swatch of the
 * family's lowest-`order` dictionary colour, `name_en` breaking ties — the legacy catalogue's
 * rule, so a family keeps one emblem whatever the narrowing.
 */
function colorFacet(all: unknown, counted: unknown) {
	const counts = new Map(
		((counted ?? []) as { _id: string; count: number }[]).map(row => [row._id, row.count])
	)
	return ((all ?? []) as { _id: string; candidates: SwatchCandidate[] }[])
		.map(row => {
			const swatch = [...row.candidates].sort(
				(a, b) =>
					(a.order ?? 0) - (b.order ?? 0) ||
					(a.name_en < b.name_en ? -1 : a.name_en > b.name_en ? 1 : 0)
			)[0]
			return {
				family: row._id,
				count: counts.get(row._id) ?? 0,
				hex_stops: swatch?.hex_stops ?? []
			}
		})
		.sort((a, b) => a.family.localeCompare(b.family))
}

/** Scope facts (branded products, drifted SKU/product pairs) are reused this long. */
const SCOPE_FACTS_MS = 30_000
/** A facet branch that is not computed: `$limit: 0` is refused by the server. */
const NOTHING = { $match: { $expr: false } }
/** Above this many product categories in scope the category facet counts the selected ones only. */
export const CATEGORY_FACET_LIMIT = 100
/** Categories per page of `GET /products/catalog/v2/category-counts` (~1 MB). */
export const CATEGORY_COUNTS_PAGE = 20_000
/** Cached totals/facets of a split listing are recomputed at least this often (see `statsOf`). */
const LISTING_STATS_MS = 60_000
/**
 * The index the price-ordered walk of the split listing reads (`ProductVariantSchema`): SKUs
 * without a promotion in price order (`promo_percent: null` is one key), and the promoted ones
 * alone (every other key) — never the whole scope.
 */
const PRICE_WALK_INDEX = { status: 1, promo_percent: 1, price: 1 }
/**
 * The split listing walks an index when the walk examines at most `1 / walkRatio` of the SKUs
 * sorting the scope would (`end × collection / total` against `total`). Specs set 0 to force the
 * walk on a small fixture.
 */
export const SPLIT_LISTING = { walkRatio: 2 }
/** A strip walks its listing this many SKUs at a time, this many steps at most (see `strip`). */
export const STRIP_WALK = { page: 100, pages: 5 }
/** Swatches one strip card carries; `colors_count` is how many colours the group has. */
export const STRIP_SWATCHES = 12

/** `hint` names an index the collection does not have (BadValue, «hint provided does not …»). */
const isMissingHint = (error: unknown) =>
	(error as { code?: number }).code === 2 && /hint/i.test(String((error as Error).message))

/** A strip card: the listing item of the product's first SKU and what its other SKUs add. */
type StripItem = mongo.Document & {
	group: {
		name: string
		count: number
		in_stock: number
		on_sale: number
		price_min: number
		price_max: number
		colors_count: number
		colors: { family: string | null; hex_stops: string[]; in_stock: boolean }[]
	}
}

type VisibleTree = Awaited<ReturnType<CategoryPublicReadService['findVisibleTree']>>

type ListingStats = {
	total: { count: number }[]
	price: { min: number; max: number }[]
	categories: { _id: mongo.ObjectId; count: number }[]
	brands: { _id: mongo.ObjectId; label: string; count: number }[]
	stock: { _id: boolean; count: number }[]
	promo_ends: { ms: number }[]
}

@Injectable()
export class PublicCatalogService {
	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly categories: CategoryPublicReadService,
		/** Optional so the v2 query specs can build this service without the legacy stack. */
		@Optional() private readonly products?: ProductService
	) {}

	/**
	 * The legacy `?polymer=PLA` catalogue, scoped to one visible v1 product category. Its
	 * projection and facets are correct exactly there; a v2 category is read through `read`
	 * (409, never a silently flattened filter), and a group, hidden branch or unknown id is 404.
	 */
	async legacy(query: Record<string, string>) {
		const id = typeof query.category_id === 'string' ? query.category_id.toLowerCase() : ''
		if (!/^[a-f0-9]{24}$/.test(id)) return this.products!.getCatalog(query)
		const category = (await this.categories.productCategories()).find(row => row._id === id)
		if (!category)
			throw new NotFoundException({
				message: 'Category not found',
				details: { code: 'CATEGORY_NOT_FOUND' }
			})
		if (category.attribute_contract_version !== 1)
			throw new ConflictException({
				message: 'This category uses the typed catalogue contract',
				details: { code: 'ATTRIBUTE_CONTRACT_UPGRADE_REQUIRED' }
			})
		return this.products!.getCatalog(query)
	}

	/** The public price sheet over SKUs of publicly visible categories only. */
	async priceSheet(query: GetPriceSheetQueryDto) {
		const visible = await this.categories.productCategories()
		return this.products!.getPriceSheet(query, {
			ids: visible.map(category => category._id),
			content: ids => this.categories.contentOf(ids, { of: visible })
		})
	}

	/**
	 * Active SKUs per visible product category over the whole catalogue (Plan-0010 D06.5) — the
	 * category facet of the unfiltered whole-catalogue listing, by the same stages (the scope, its
	 * drifted pairs, the joined path when products carry brands), without its 100-category limit
	 * and outside the listing. Navigation counts its non-empty branches from it. Kept per tree key
	 * and SKU write mark for at most `LISTING_STATS_MS` (the counts, not a response); paged by
	 * category id, `CATEGORY_COUNTS_PAGE` at a time, the cursor bound to that computation (409
	 * restart when it was replaced).
	 */
	async categoryCounts(query: { cursor?: unknown; limit?: unknown }) {
		// A plain positive integer, as the listing's `limit` (`0x2`, `1e3`, ` 5` are refused).
		const limit =
			query.limit === undefined
				? CATEGORY_COUNTS_PAGE
				: typeof query.limit === 'string' &&
					  /^[1-9]\d*$/.test(query.limit) &&
					  Number(query.limit) <= CATEGORY_COUNTS_PAGE
					? Number(query.limit)
					: null
		if (limit === null) throw new BadRequestException('Invalid limit')
		let after: { key: string; last: string } | null = null
		if (query.cursor !== undefined) {
			try {
				if (typeof query.cursor !== 'string') throw Error()
				after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
					key: string
					last: string
				}
				if (!after || typeof after.key !== 'string' || !/^[a-f0-9]{24}$/.test(after.last))
					throw Error()
			} catch {
				throw new BadRequestException('Invalid cursor')
			}
		}
		const policy = new LegacyCatalogWritePolicy(this.connection)
		const stamp = await policy.beginRead(true)
		const visible = await this.categories.findVisibleTree()
		const tree = this.treeOf(visible)
		const { scopeIds } = this.scopeOf(tree, null)
		const treeKey =
			this.categories.keyOf(visible) ?? (await categoryFingerprint(this.connection))
		const mark = await variantWriteMark(this.connection)
		const key = createHash('sha256')
			// Without a write mark (an older server) the counts live out their 60 s instead.
			.update(JSON.stringify([treeKey, mark?.mark ?? null]))
			.digest('hex')
		let entry = this.countsEntry
		if (!entry || entry.key !== key || Date.now() >= entry.expires) {
			const facts = await this.factsOf(`all:${treeKey}`, scopeIds)
			const rows = this.connection
				.collection(facts.branded ? 'products' : 'product_variants')
				.aggregate<{ _id: mongo.ObjectId; count: number }>(
					[
						...(facts.branded
							? this.skuStages(scopeIds)
							: this.variantStages(scopeIds, facts.drifted)),
						{ $group: { _id: '$category_id', count: { $sum: 1 } } },
						{ $sort: { _id: 1 } }
					],
					{ readPreference: 'primary', allowDiskUse: true }
				)
				.toArray()
				.then(found => found.map(row => ({ id: row._id.toHexString(), count: row.count })))
			entry = { key, expires: Date.now() + LISTING_STATS_MS, rows }
			this.countsEntry = entry
			const current = entry
			rows.catch(() => {
				if (this.countsEntry === current) this.countsEntry = null
			})
		}
		const rows = await entry.rows
		await policy.finishRead(stamp, true)
		if (after && after.key !== key)
			throw new ConflictException({
				message: 'Category counts changed; restart pagination',
				details: { code: 'CATEGORY_COUNTS_CHANGED' }
			})
		const start = after ? rows.findIndex(row => row.id > after.last) : 0
		const from = start === -1 ? rows.length : start
		const page = rows.slice(from, from + limit)
		return {
			revision: stamp.revision,
			categories: page,
			next_cursor:
				from + page.length < rows.length
					? Buffer.from(JSON.stringify({ key, last: page.at(-1)!.id })).toString(
							'base64url'
						)
					: null
		}
	}
	private countsEntry: {
		key: string
		expires: number
		rows: Promise<{ id: string; count: number }[]>
	} | null = null

	/** Site search over SKUs of publicly visible categories only — v1 and v2 alike. */
	async search(dto: SearchProductsDto) {
		const visible = await this.categories.productCategories()
		return this.products!.search(
			dto,
			visible.map(category => category._id)
		)
	}
	async read(raw: unknown) {
		return this.listing(parsePublicCatalogQuery(raw))
	}
	/**
	 * The listing of a parsed query. `plain` is the page a strip walks (see `strip`): the same
	 * `items`, read without a `$facet` — nothing is counted over the scope for an answer nobody
	 * reads, so its `total` and `facets` are not the listing's (zero and empty; only the split
	 * listing counts, what its page is cut by). The public listing is never plain.
	 */
	private async listing(query: ReturnType<typeof parsePublicCatalogQuery>, plain = false) {
		const policy = new LegacyCatalogWritePolicy(this.connection)
		const stamp = await policy.beginRead(true)
		const { visible, tree, selected, ids, scopeIds, definitions, conditions } =
			await this.scopeOfQuery(query)
		const filters = query.filters
		const colorAxis = definitions.some(definition => definition.semantic === 'color')
		// Nothing product-level to match or count: skip the product join for the whole scope and
		// fetch product fields for the page's items only (see `variantStages`).
		// The key the tree was just read under (stamp + category fingerprint): hashing the
		// categories again here cost a second ~70 ms pass per request at 10 000 categories.
		const treeKey =
			this.categories.keyOf(visible) ?? (await categoryFingerprint(this.connection))
		const facts =
			!definitions.length && !filters.brand_ids.length
				? await this.factsOf(`${selected?._id ?? 'all'}:${treeKey}`, scopeIds)
				: null
		const variantOnly = facts !== null && !facts.branded
		// A category facet over thousands of leaves is neither a usable filter nor a sane payload
		// (9 800 rows, 700 KB on the large-catalogue fixture): beyond this many product categories
		// only the selected ones are counted, for their chips; the tiles navigate instead.
		const categoryFacet =
			ids.size <= CATEGORY_FACET_LIMIT
				? 'all'
				: filters.category_ids.length
					? 'selected'
					: 'none'
		const match = (exclude?: string): mongo.Document[] => {
			const clauses = [...conditions]
				.filter(([key]) => key !== exclude)
				.map(([, value]) => value)
			return clauses.length ? [{ $match: { $and: clauses } }] : []
		}
		const enabled = plain
			? []
			: definitions
					.filter(definition => definition.filter_enabled)
					.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
		// In-stock SKUs first under every order, as the legacy listing (`findCatalogItems`) always
		// sorted: without it the migrated filament's first page mixed sold-out spools into «newest».
		// A curated list (`product_ids`) keeps the admin's order under the default sort.
		const listed = filters.product_ids.length > 0 && query.sort === 'newest'
		const sort = {
			_out_of_stock: 1,
			...(listed ? { _listed: 1 } : {}),
			...(query.sort === 'price_asc'
				? { _price: 1, _id: 1 }
				: query.sort === 'price_desc'
					? { _price: -1, _id: 1 }
					: { _id: -1 })
		}
		const facets: Record<string, mongo.Document[]> = {
			items: [
				...match(),
				{
					$addFields: {
						_out_of_stock: { $cond: [{ $gt: ['$stock', 0] }, 0, 1] },
						...(listed
							? {
									_listed: {
										$indexOfArray: [
											filters.product_ids.map(id => new mongo.ObjectId(id)),
											'$product_id'
										]
									}
								}
							: {})
					}
				},
				{ $sort: sort },
				{ $skip: (query.page - 1) * query.limit },
				{ $limit: query.limit },
				...this.pageStages(variantOnly)
			],
			total: [...match(), { $count: 'count' }],
			// The slider's bounds over the whole scope, whatever else is selected — bounds that jump
			// after every click make the control unusable (TD-0008 §4 F7, as the legacy catalogue;
			// owner decision 31.10.2026). The counts below stay those of the narrowed listing.
			price: [{ $group: { _id: null, min: { $min: '$_price' }, max: { $max: '$_price' } } }],
			categories:
				categoryFacet === 'none'
					? [NOTHING]
					: [
							...match('category'),
							...(categoryFacet === 'selected'
								? [
										{
											$match: {
												category_id: {
													$in: filters.category_ids.map(
														id => new mongo.ObjectId(id)
													)
												}
											}
										}
									]
								: []),
							{ $group: { _id: '$category_id', count: { $sum: 1 } } },
							{ $sort: { _id: 1 } }
						],
			brands: [
				...(variantOnly ? [NOTHING] : []),
				...match('brand'),
				{ $match: { 'product.brand_id': { $type: 'objectId' } } },
				{ $group: { _id: '$product.brand_id', count: { $sum: 1 } } },
				{
					$lookup: { from: 'brands', localField: '_id', foreignField: '_id', as: 'brand' }
				},
				{ $unwind: '$brand' },
				{ $match: { 'brand.status': 'active' } },
				{ $project: { _id: 1, count: 1, label: '$brand.name' } },
				{ $sort: { _id: 1 } }
			],
			stock: [
				...match('stock'),
				{ $group: { _id: { $gt: ['$stock', 0] }, count: { $sum: 1 } } }
			],
			...(colorAxis
				? {
						// Every family of the scope, so a ticked swatch never disappears, and the
						// self-excluding count beside it (TD-0008 rule, as in the legacy catalogue).
						colors_all: [
							{ $match: { color_family: { $type: 'string' } } },
							// One dictionary lookup per distinct colour, not per SKU.
							{
								$group: {
									_id: { family: '$color_family', color_id: '$color_id' }
								}
							},
							{
								$project: {
									_id: 0,
									color_family: '$_id.family',
									color_id: '$_id.color_id'
								}
							},
							{
								$lookup: {
									from: 'colors',
									localField: 'color_id',
									foreignField: '_id',
									as: 'swatch',
									pipeline: [
										{ $project: { _id: 0, order: 1, name_en: 1, hex_stops: 1 } }
									]
								}
							},
							{ $unwind: '$swatch' },
							{
								$group: {
									_id: '$color_family',
									candidates: { $addToSet: '$swatch' }
								}
							}
						],
						colors: [
							...match('color'),
							{ $match: { color_family: { $type: 'string' } } },
							{ $group: { _id: '$color_family', count: { $sum: 1 } } }
						]
					}
				: {})
		}
		// While anything narrows the listing, a value another dimension brings down to zero stays
		// listed with 0 (TD-0008, as the legacy catalogue does): the scope's own values come from an
		// unfiltered branch. Without filters the counted branch already holds every value.
		const narrowed = conditions.size > 0
		for (const [index, definition] of enabled.entries()) {
			facets[`a${index}`] = [
				...match(`attribute:${definition.key}`),
				{ $unwind: '$_attrs' },
				{ $match: { '_attrs.k': definition.key } },
				{ $group: { _id: { sku: '$_id', value: '$_attrs.v' } } },
				{ $group: { _id: '$_id.value', count: { $sum: 1 } } },
				{ $sort: { _id: 1 } }
			]
			// A number's bounds, like the price's, are the scope's under any filter (TD-0008 §4 F7).
			if (narrowed && definition.value_type === 'number')
				facets[`r${index}`] = [
					{ $unwind: '$_attrs' },
					{ $match: { '_attrs.k': definition.key, '_attrs.v': { $type: 'number' } } },
					{
						$group: {
							_id: null,
							min: { $min: '$_attrs.v' },
							max: { $max: '$_attrs.v' }
						}
					}
				]
			if (narrowed && definition.filter_type !== 'range')
				facets[`s${index}`] = [
					{ $unwind: '$_attrs' },
					{ $match: { '_attrs.k': definition.key } },
					{ $group: { _id: '$_attrs.v' } },
					{ $sort: { _id: 1 } }
				]
		}
		type Listing = {
			items: mongo.Document[]
			total: { count: number }[]
			price: { min: number; max: number }[]
			categories: { _id: mongo.ObjectId; count: number }[]
			brands: { _id: mongo.ObjectId; label: string; count: number }[]
			stock: { _id: boolean; count: number }[]
			[key: string]: unknown
		}
		// The whole catalogue and groups (variant-only, no curated list): totals and facets cached
		// per scope and filters until any SKU write, the page read by an index walk — instead of
		// sorting and counting every SKU in scope on each request (Plan-0010 D06, 100 000 SKUs).
		const split =
			variantOnly && !filters.product_ids.length && treeKey !== null
				? await this.splitListing({
						// A strip's counts are kept apart from the listing's totals and facets.
						key: JSON.stringify([
							treeKey,
							selected?._id ?? null,
							query.filters,
							...(plain ? ['plain'] : [])
						]),
						facts,
						scope: this.variantStages(scopeIds, facts.drifted),
						facets,
						conditions,
						query,
						plain
					})
				: null
		const aggregate = <T extends mongo.Document>(stages: mongo.Document[]) =>
			this.connection
				.collection(variantOnly ? 'product_variants' : 'products')
				.aggregate<T>(
					[
						...(variantOnly
							? this.variantStages(scopeIds, facts.drifted)
							: this.skuStages(scopeIds)),
						...stages
					],
					{ readPreference: 'primary', maxTimeMS: 15000 }
				)
				.toArray()
		const data: Listing =
			split ??
			(plain
				? // The `items` branch as the pipeline itself: one pass that stops at the page,
					// nothing counted — a total here is the product join a second time.
					{
						items: await aggregate(facets.items),
						total: [],
						price: [],
						categories: [],
						brands: [],
						stock: []
					}
				: (await aggregate<Listing>([{ $facet: facets }]))[0])
		await policy.finishRead(stamp, true)
		return {
			revision: stamp.revision,
			items: data.items,
			page: query.page,
			limit: query.limit,
			total: data.total[0]?.count ?? 0,
			facets: {
				attributes: enabled.map((definition, index) => {
					const values = data[`a${index}`] as {
						_id: string | number | boolean
						count: number
					}[]
					const scope = data[`s${index}`] as
						| { _id: string | number | boolean }[]
						| undefined
					// Keyed by JSON so the number 1 and the text "1" stay different values.
					const counts = new Map(values.map(row => [JSON.stringify(row._id), row.count]))
					const numbers = values
						.map(row => row._id)
						.filter((value): value is number => typeof value === 'number')
					const bounds = (
						data[`r${index}`] as { min: number; max: number }[] | undefined
					)?.[0]
					return {
						key: definition.key,
						values:
							definition.filter_type === 'range'
								? []
								: (scope ?? values).map(row => ({
										value: row._id,
										count: counts.get(JSON.stringify(row._id)) ?? 0
									})),
						min:
							bounds?.min ??
							(numbers.length
								? numbers.reduce((min, value) => Math.min(min, value), Infinity)
								: null),
						max:
							bounds?.max ??
							(numbers.length
								? numbers.reduce((max, value) => Math.max(max, value), -Infinity)
								: null)
					}
				}),
				categories: data.categories.map(row => ({
					id: String(row._id),
					label: tree.byId.get(String(row._id))!.name,
					count: row.count
				})),
				brands: data.brands.map(row => ({
					id: String(row._id),
					label: row.label,
					count: row.count
				})),
				price: { min: data.price[0]?.min ?? null, max: data.price[0]?.max ?? null },
				in_stock: {
					true: data.stock.find(row => row._id)?.count ?? 0,
					false: data.stock.find(row => !row._id)?.count ?? 0
				},
				colors: colorAxis ? colorFacet(data.colors_all, data.colors) : []
			}
		}
	}
	/**
	 * A product strip (the storefront's «Новинки», «Акції», a collection): the first cards of the
	 * «newest» listing under the same scope and filters, **one per product** — its first SKU there
	 * (in stock before sold out, newest first, a curated list in the admin's order) — with what the
	 * product's other SKUs under those filters add: how many, their colours, the price range. A
	 * product arrives with all its colours at once, so the SKU listing's first page was one product
	 * seven times (owner, 2026-11-14).
	 *
	 * The products are found by walking the listing itself (`listing`, so every path, filter and
	 * guard is the listing's) `STRIP_WALK.page` SKUs at a time, at most `STRIP_WALK.pages` steps: a
	 * strip looks at the first 500 SKUs and may come back shorter than `limit` past that. A step
	 * reads the page's items and total only — never the listing's facets, which were computed over
	 * the whole scope on every step and thrown away (audit 14.11). The groups are one aggregation
	 * over the chosen products only.
	 */
	async strip(raw: unknown) {
		const query = parseCatalogStripQuery(raw)
		const policy = new LegacyCatalogWritePolicy(this.connection)
		const stamp = await policy.beginRead(true)
		const { scopeIds, conditions } = await this.scopeOfQuery(query)
		const first = new Map<string, mongo.Document>()
		for (let page = 1; page <= STRIP_WALK.pages && first.size < query.limit; page++) {
			const listing = await this.listing(
				{ ...query, page, limit: STRIP_WALK.page, sort: 'newest' },
				true
			)
			for (const item of listing.items)
				if (first.size < query.limit && !first.has(item.product_id as string))
					first.set(item.product_id as string, item)
			// A short page is the listing's last one: the walk needs no total for that.
			if (listing.items.length < STRIP_WALK.page) break
		}
		const productIds = [...first.keys()].map(id => new mongo.ObjectId(id))
		const clauses = [...conditions.values()]
		const options = { readPreference: 'primary' as const, maxTimeMS: 15000 }
		const [groups, names] = productIds.length
			? await Promise.all([
					this.connection
						.collection('products')
						.aggregate<{
							_id: mongo.ObjectId
							count: number
							in_stock: number
							on_sale: number
							min: number | null
							max: number | null
							min_in_stock: number | null
							max_in_stock: number | null
							colors: { id: mongo.ObjectId | null; in_stock: boolean }[]
						}>(
							[
								// The chosen products only, then the listing's own join and conditions.
								{ $match: { _id: { $in: productIds } } },
								...this.skuStages(scopeIds),
								...(clauses.length ? [{ $match: { $and: clauses } }] : []),
								{ $addFields: { _in_stock: { $gt: ['$stock', 0] } } },
								// The listing's order, so the swatches start with what can be bought.
								{ $sort: { _in_stock: -1, _id: -1 } },
								{
									$group: {
										_id: '$product_id',
										count: { $sum: 1 },
										in_stock: { $sum: { $cond: ['$_in_stock', 1, 0] } },
										// As `on_sale` filters: a saving right now (TD-0012).
										on_sale: {
											$sum: {
												$cond: [{ $ne: [salePriceExpr(), null] }, 1, 0]
											}
										},
										min: { $min: '$_price' },
										max: { $max: '$_price' },
										// `$min`/`$max` skip nulls: the sold-out SKUs.
										min_in_stock: {
											$min: { $cond: ['$_in_stock', '$_price', null] }
										},
										max_in_stock: {
											$max: { $cond: ['$_in_stock', '$_price', null] }
										},
										colors: {
											$push: {
												id: { $ifNull: ['$color_id', null] },
												in_stock: '$_in_stock'
											}
										}
									}
								}
							],
							options
						)
						.toArray(),
					this.connection
						.collection('products')
						.find<{
							_id: mongo.ObjectId
							name?: string
						}>({ _id: { $in: productIds } }, { projection: { name: 1 }, ...options })
						.toArray()
				])
			: [[], []]
		// Distinct dictionary colours of each group, in the listing's order — in stock first, so a
		// colour's first SKU says whether it can be bought.
		const distinct = new Map(
			groups.map(group => {
				const seen = new Map<string, boolean>()
				for (const color of group.colors) {
					const id = color.id?.toHexString()
					if (id !== undefined && !seen.has(id)) seen.set(id, color.in_stock)
				}
				return [group._id.toHexString(), [...seen]] as const
			})
		)
		const shown = [...distinct.values()].flatMap(colors =>
			colors.slice(0, STRIP_SWATCHES).map(([id]) => id)
		)
		const swatches = shown.length
			? await this.connection
					.collection('colors')
					.find<{
						_id: mongo.ObjectId
						family?: string
						hex_stops?: string[]
					}>(
						{ _id: { $in: [...new Set(shown)].map(id => new mongo.ObjectId(id)) } },
						{ projection: { family: 1, hex_stops: 1 }, ...options }
					)
					.toArray()
			: []
		const swatchOf = new Map(swatches.map(color => [color._id.toHexString(), color]))
		const groupOf = new Map(groups.map(group => [group._id.toHexString(), group]))
		const nameOf = new Map(names.map(product => [product._id.toHexString(), product.name]))
		await policy.finishRead(stamp, true)
		return {
			revision: stamp.revision,
			items: [...first].map(([productId, item]): StripItem => {
				const group = groupOf.get(productId)
				const colors = distinct.get(productId) ?? []
				const own = (item.sale_price ?? item.price) as number
				return {
					...item,
					group: {
						// A SKU the listing showed and the join dropped in the same moment (a
						// product moved between the two reads) stands alone, as its own group.
						name: nameOf.get(productId) ?? (item.name as string),
						count: group?.count ?? 1,
						in_stock: group?.in_stock ?? ((item.stock as number) > 0 ? 1 : 0),
						on_sale: group?.on_sale ?? (item.sale_price == null ? 0 : 1),
						// What can be bought now; of a sold-out product, what it costs.
						price_min: group?.min_in_stock ?? group?.min ?? own,
						price_max: group?.max_in_stock ?? group?.max ?? own,
						colors_count: colors.length,
						colors: colors.slice(0, STRIP_SWATCHES).flatMap(([id, inStock]) => {
							const color = swatchOf.get(id)
							return color
								? [
										{
											family: color.family ?? null,
											hex_stops: color.hex_stops ?? [],
											in_stock: inStock
										}
									]
								: []
						})
					}
				}
			})
		}
	}

	/**
	 * The scope and conditions of one catalogue query — one tree read for both the scope and the
	 * selected node (groups included). Shared by the listing and a strip, so a strip groups
	 * exactly what its listing lists; throws the listing's 404 and 400s.
	 */
	private async scopeOfQuery(query: { category_id?: string; filters: CatalogFilters }) {
		const visible = await this.categories.findVisibleTree()
		const tree = this.treeOf(visible)
		const selected = query.category_id
			? (tree.byId.get(query.category_id.toLowerCase()) ?? undefined)
			: null
		if (selected === undefined) throw new NotFoundException('Category not found')
		const { ids, scopeIds } = this.scopeOf(tree, selected)
		if (query.filters.category_ids.some(id => !ids.has(id.toLowerCase())))
			throw new BadRequestException('Category is outside catalog scope')
		// The tree carries no content (Plan-0010 D06): the selected v2 category's definitions are read
		// by id against that same tree.
		const definitions =
			selected?.kind === 'product' && selected.attribute_contract_version === 2
				? (await this.categories.contentOf([selected._id], { of: visible })).get(
						selected._id
					)!.attribute_definitions
				: []
		return {
			visible,
			tree,
			selected,
			ids,
			scopeIds,
			definitions,
			conditions: this.conditionsOf(query.filters, definitions)
		}
	}

	/**
	 * What every catalogue read derives from the visible tree — the node index, the product
	 * categories and each requested scope's ids — kept on the tree read itself (the reader's memo
	 * hands every request the same list until any category write), not rebuilt per request: at
	 * 10 000 categories the per-request maps, filters and 9 800 ObjectIds were the API's largest
	 * allocations under load (~3 GB/min of garbage, Plan-0010 D06 profile 29.10).
	 */
	private readonly trees = new WeakMap<
		VisibleTree,
		{
			byId: Map<string, VisibleTree[number]>
			products: VisibleTree
			children: Map<string | null, string[]>
			scopes: Map<string, { ids: Set<string>; scopeIds: mongo.ObjectId[] }>
		}
	>()
	private treeOf(visible: VisibleTree) {
		let tree = this.trees.get(visible)
		if (!tree) {
			const children = new Map<string | null, string[]>()
			for (const node of visible) {
				const siblings = children.get(node.parent_id)
				if (siblings) siblings.push(node._id)
				else children.set(node.parent_id, [node._id])
			}
			tree = {
				byId: new Map(visible.map(node => [node._id, node])),
				products: visible.filter(node => node.kind === 'product'),
				children,
				scopes: new Map()
			}
			this.trees.set(visible, tree)
		}
		return tree
	}
	/** Product categories of the whole catalogue (`selected` null) or of one node and its branch. */
	private scopeOf(
		tree: ReturnType<PublicCatalogService['treeOf']>,
		selected: VisibleTree[number] | null
	) {
		const key = selected?._id ?? ''
		let scope = tree.scopes.get(key)
		if (!scope) {
			// The selected node's branch, walked down from it (the tree carries no ancestors); the
			// product categories keep the tree's order.
			let branch: Set<string> | null = null
			if (selected) {
				branch = new Set()
				for (const stack = [selected._id]; stack.length; ) {
					const id = stack.pop()!
					branch.add(id)
					for (const child of tree.children.get(id) ?? []) stack.push(child)
				}
			}
			const ids = new Set(
				tree.products
					.filter(category => !branch || branch.has(category._id))
					.map(category => category._id)
			)
			scope = { ids, scopeIds: [...ids].map(id => new mongo.ObjectId(id)) }
			if (tree.scopes.size >= 2000) tree.scopes.clear()
			tree.scopes.set(key, scope)
		}
		return scope
	}

	/**
	 * The listing shape of the page's SKUs (root = the SKU): product fields on the variant-only
	 * path, the dictionary colour, the public projection. Shared by the single aggregation and the
	 * split listing's detail read, so both return byte-identical items.
	 */
	private pageStages(variantOnly: boolean): mongo.Document[] {
		return [
			...(variantOnly ? this.itemProductStages() : []),
			// Dictionary colour of the page's SKUs only — not of every SKU in scope.
			{
				$lookup: {
					from: 'colors',
					localField: 'color_id',
					foreignField: '_id',
					as: '_color',
					pipeline: [
						{
							$project: {
								_id: 0,
								name_uk: 1,
								name_en: 1,
								family: 1,
								hex_stops: 1
							}
						}
					]
				}
			},
			{
				$project: {
					_id: 0,
					id: { $toString: '$_id' },
					product_id: { $toString: '$product_id' },
					category_id: { $toString: '$category_id' },
					name: 1,
					slug: 1,
					sku: 1,
					price: 1,
					stock: 1,
					price_updated_at: { $ifNull: ['$price_updated_at', null] },
					v_value: { $ifNull: ['$v_value', null] },
					variant_value: { $ifNull: ['$variant_value', null] },
					attributes_v2: '$_attrs',
					brand_id: {
						$convert: { input: '$product.brand_id', to: 'string', onNull: null }
					},
					main_image: { $ifNull: [{ $arrayElemAt: ['$images', 0] }, null] },
					color: { $ifNull: [{ $arrayElemAt: ['$_color', 0] }, null] },
					...publicPromoProjection()
				}
			}
		]
	}

	/**
	 * The variant-only listing without sorting or counting the whole scope per request — the
	 * same totals, facets and page as the single `$facet` aggregation (`public-catalog.int-spec`
	 * «split listing» compares them on a mixed tree):
	 *
	 * - **totals and facets** (`total`, price bounds, stock and category counts) come from that
	 *   aggregation without its `items` branch, cached per scope + filters and reused while the
	 *   SKU write mark (`variantWriteMark`), the tree key, the scope facts and the earliest
	 *   promotion end in scope hold — at most `LISTING_STATS_MS`. Concurrent requests share one
	 *   computation. No response is cached: items are read on every request;
	 * - **the page**: in-stock SKUs precede sold-out ones (`pageSegments`), each run read by an index
	 *   walk — `_id` descending for «newest»; for a price order `PRICE_WALK_INDEX`: SKUs without a
	 *   promotion in price order (their effective price is the price), merged with the first
	 *   promoted SKUs of the run sorted by their effective price (`slicePriced`);
	 * - when the walk would examine more than half of what sorting the scope does (a small scope or
	 *   a deep page), the page is the single aggregation's `items` branch alone.
	 *
	 * `null` when the server reports no write mark: the caller then runs the single aggregation.
	 */
	private async splitListing(input: {
		key: string
		facts: object
		scope: mongo.Document[]
		facets: Record<string, mongo.Document[]>
		conditions: Map<string, mongo.Document>
		query: ReturnType<typeof parsePublicCatalogQuery>
		/** A strip's walk: the counts its page needs, no facet (see `listing`). */
		plain?: boolean
	}) {
		const mark = await variantWriteMark(this.connection)
		if (mark === null) return null
		const { query, scope } = input
		const filters = query.filters
		const variants = this.connection.collection('product_variants')
		const options = { readPreference: 'primary' as const, maxTimeMS: 15000 }
		const { items: itemsBranch, ...counted } = input.facets
		// When the next promotion in scope ends, prices and order change.
		const promoEnds = [
			{
				$match: {
					promo_percent: { $ne: null },
					$expr: { $gt: ['$promo_ends_at', '$$NOW'] }
				}
			},
			{ $group: { _id: null, at: { $min: '$promo_ends_at' } } },
			{ $project: { _id: 0, ms: { $subtract: ['$at', '$$NOW'] } } }
		]
		const stats = await this.statsOf(input.key, mark.mark, input.facts, async () => {
			// What the page of a strip is cut by — the total and the in-stock count — and the
			// bound of this cache entry, each a pipeline of its own; price bounds, categories and
			// brands are the listing's.
			if (input.plain) {
				const count = <T extends mongo.Document>(stages: mongo.Document[]) =>
					variants.aggregate<T>([...scope, ...stages], options).toArray()
				const [total, stock, promo_ends] = await Promise.all([
					count<ListingStats['total'][number]>(counted.total),
					count<ListingStats['stock'][number]>(counted.stock),
					count<ListingStats['promo_ends'][number]>(promoEnds)
				])
				return { total, stock, promo_ends, price: [], categories: [], brands: [] }
			}
			const [row] = await variants
				.aggregate<ListingStats>(
					[...scope, { $facet: { ...counted, promo_ends: promoEnds } }],
					options
				)
				.toArray()
			return row
		})
		const total = stats.total[0]?.count ?? 0
		const inStock =
			filters.in_stock === undefined
				? (stats.stock.find(row => row._id)?.count ?? 0)
				: filters.in_stock
					? total
					: 0
		const offset = (query.page - 1) * query.limit
		const segments = pageSegments(offset, query.limit, total, inStock)
		const end = Math.min(offset + query.limit, total)
		const walk = end * mark.count * SPLIT_LISTING.walkRatio <= total * total
		const sorted = () => variants.aggregate([...scope, ...itemsBranch], options).toArray()
		let items: mongo.Document[]
		if (!segments.length) items = []
		else if (!walk) items = await sorted()
		else {
			const base = scope[0].$match as mongo.Document
			// The listing's conditions with the effective price as `$expr`: the walk reads SKUs as
			// stored, before `_price` exists.
			const raw = (withPrice: boolean) =>
				[...input.conditions.entries()].flatMap(([key, value]) =>
					key !== 'price'
						? [value]
						: withPrice && filters.price
							? [
									{
										$expr: {
											$and: [
												...(filters.price.min === undefined
													? []
													: [
															{
																$gte: [
																	effectivePriceExpr(),
																	filters.price.min
																]
															}
														]),
												...(filters.price.max === undefined
													? []
													: [
															{
																$lte: [
																	effectivePriceExpr(),
																	filters.price.max
																]
															}
														])
											]
										}
									}
								]
							: []
				)
			const run = (segment: PageSegment) => ({
				$expr: segment.out ? { $not: [{ $gt: ['$stock', 0] }] } : { $gt: ['$stock', 0] }
			})
			const newest = async (segment: PageSegment) =>
				(
					await variants
						.aggregate<{
							_id: mongo.ObjectId
						}>(
							[
								{ $match: { ...base, $and: [...raw(true), run(segment)] } },
								{ $sort: { _id: -1 } },
								{ $skip: segment.skip },
								{ $limit: segment.take },
								{ $project: { _id: 1 } }
							],
							{ ...options, hint: { _id: 1 } }
						)
						.toArray()
				).map(row => row._id)
			const direction = query.sort === 'price_desc' ? -1 : 1
			const priced = async (segment: PageSegment) => {
				// Without a promotion the effective price is the price itself: an index range.
				const plain = {
					...base,
					promo_percent: null,
					$and: [
						...raw(false),
						run(segment),
						...(filters.price
							? [
									{
										price: {
											...(filters.price.min === undefined
												? {}
												: { $gte: filters.price.min }),
											...(filters.price.max === undefined
												? {}
												: { $lte: filters.price.max })
										}
									}
								]
							: [])
					]
				}
				const read = async (extra: mongo.Document, limit?: number) =>
					(
						await variants
							.aggregate<{
								_id: mongo.ObjectId
								price?: number | null
							}>(
								[
									{ $match: { ...plain, ...extra } },
									{ $sort: { price: direction } },
									...(limit === undefined ? [] : [{ $limit: limit }]),
									{ $project: { _id: 1, price: 1 } }
								],
								{ ...options, hint: PRICE_WALK_INDEX }
							)
							.toArray()
					).map((row): PricedId => ({ _id: row._id, key: row.price ?? null }))
				const limit = segment.skip + segment.take
				const head = await read({}, limit)
				const rows = await withTies(head, limit, () => read({ price: head[limit - 1].key }))
				// The promoted SKUs of the run (index keys other than null), by effective price.
				const promoted = (
					await variants
						.aggregate<{ _id: mongo.ObjectId; _price?: number | null }>(
							[
								{
									$match: {
										...base,
										promo_percent: { $ne: null },
										$and: [...raw(true), run(segment)]
									}
								},
								{ $addFields: { _price: effectivePriceExpr() } },
								{ $sort: { _price: direction, _id: 1 } },
								{ $limit: limit },
								{ $project: { _id: 1, _price: 1 } }
							],
							{ ...options, hint: PRICE_WALK_INDEX }
						)
						.toArray()
				).map((row): PricedId => ({ _id: row._id, key: row._price ?? null }))
				return slicePriced(
					[...rows, ...promoted],
					direction,
					segment.skip,
					segment.take
				).map(row => row._id)
			}
			const order: mongo.ObjectId[] = []
			try {
				for (const segment of segments)
					order.push(
						...(await (query.sort === 'newest' ? newest(segment) : priced(segment)))
					)
			} catch (error) {
				// The price index is still being built (or was dropped): sort the scope instead.
				if (!isMissingHint(error)) throw error
				return { ...this.statsShape(stats), items: await sorted() }
			}
			const rows = order.length
				? await variants
						.aggregate<mongo.Document>(
							[
								{ $match: { _id: { $in: order }, status: 'active' } },
								...this.pageStages(true)
							],
							options
						)
						.toArray()
				: []
			const byId = new Map(rows.map(row => [row.id as string, row]))
			items = order
				.map(id => byId.get(id.toHexString()))
				.filter((row): row is mongo.Document => row !== undefined)
		}
		return { ...this.statsShape(stats), items }
	}
	private statsShape(stats: ListingStats) {
		return {
			total: stats.total,
			price: stats.price,
			categories: stats.categories,
			brands: stats.brands,
			stock: stats.stock
		}
	}

	/** Cached totals/facets of split listings (see `splitListing`), shared by concurrent reads. */
	private readonly listingStats = new Map<
		string,
		{ mark: string; facts: object; expires: number; stats: Promise<ListingStats> }
	>()
	private statsOf(
		key: string,
		mark: string,
		facts: object,
		compute: () => Promise<ListingStats>
	): Promise<ListingStats> {
		const cached = this.listingStats.get(key)
		if (cached && cached.mark === mark && cached.facts === facts && Date.now() < cached.expires)
			return cached.stats
		const at = Date.now()
		const entry = { mark, facts, expires: at + LISTING_STATS_MS, stats: compute() }
		entry.stats.then(
			row => {
				// `ms` is measured on the server clock from its `$$NOW`, which is not earlier than
				// `at`: the entry never outlives the promotion, whatever the clocks' offset.
				const ms = row.promo_ends[0]?.ms
				if (typeof ms === 'number') entry.expires = Math.min(entry.expires, at + ms)
			},
			() => {
				if (this.listingStats.get(key) === entry) this.listingStats.delete(key)
			}
		)
		if (this.listingStats.size > 200) this.listingStats.clear()
		this.listingStats.set(key, entry)
		return entry.stats
	}

	/**
	 * Mongo conditions of one catalogue `filters` object over a scope with these definitions —
	 * shared by the listing and the typed landing counts, so a landing tile counts exactly what
	 * its page lists. Throws the same 400s the listing answers.
	 */
	private conditionsOf(filters: CatalogFilters, definitions: AttributeDefinition[]) {
		// Colour is the dictionary family on the SKU, and only where the category declares a
		// colour axis; an arbitrary value is never interpreted as a colour.
		const colorAxis = definitions.some(definition => definition.semantic === 'color')
		if (
			filters.color_families.length &&
			(!colorAxis ||
				filters.color_families.some(
					family => !(Object.values(ColorFamily) as string[]).includes(family)
				))
		)
			throw new BadRequestException({
				message: 'Colour filter is outside this category',
				details: { code: 'INVALID_COLOR_FILTER' }
			})
		const attributes = publicCatalogAttributes(definitions, filters.attributes)
		const conditions = new Map<string, mongo.Document>()
		for (const filter of attributes)
			conditions.set(`attribute:${filter.key}`, {
				_attrs: {
					$elemMatch: {
						k: filter.key,
						v:
							'values' in filter
								? { $in: filter.values }
								: {
										...(filter.min === undefined ? {} : { $gte: filter.min }),
										...(filter.max === undefined ? {} : { $lte: filter.max })
									}
					}
				}
			})
		if (filters.price)
			conditions.set('price', {
				_price: {
					...(filters.price.min === undefined ? {} : { $gte: filters.price.min }),
					...(filters.price.max === undefined ? {} : { $lte: filters.price.max })
				}
			})
		if (filters.in_stock !== undefined)
			conditions.set('stock', { stock: filters.in_stock ? { $gt: 0 } : { $lte: 0 } })
		if (filters.category_ids.length)
			conditions.set('category', {
				category_id: { $in: filters.category_ids.map(id => new mongo.ObjectId(id)) }
			})
		if (filters.color_families.length)
			conditions.set('color', { color_family: { $in: [...new Set(filters.color_families)] } })
		if (filters.product_ids.length)
			conditions.set('product', {
				product_id: { $in: filters.product_ids.map(id => new mongo.ObjectId(id)) }
			})
		if (filters.brand_ids.length)
			conditions.set('brand', {
				'product.brand_id': { $in: filters.brand_ids.map(id => new mongo.ObjectId(id)) }
			})
		// The live sale price the page shows (`publicPromoProjection`), computed from the stored
		// fields, so it also holds for the index walk, which reads SKUs before `_price` exists.
		if (filters.on_sale) conditions.set('promo', { $expr: { $ne: [salePriceExpr(), null] } })
		return conditions
	}

	/** `_attrs`: the product's typed values plus the SKU's own axis value, as one list to match. */
	private attrsExpr() {
		return {
			$concatArrays: [
				{
					$map: {
						input: { $ifNull: ['$product.attributes_v2', []] },
						as: 'attr',
						in: { k: '$$attr.k', v: '$$attr.v' }
					}
				},
				{
					$cond: [
						{ $ne: [{ $ifNull: ['$product.variant_axis.key', null] }, null] },
						[{ k: '$product.variant_axis.key', v: '$variant_value' }],
						[]
					]
				}
			]
		}
	}

	/**
	 * Active SKUs of the categories with the typed values (`_attrs`) and price (`_price`) matched
	 * on — aggregated on `products`. The join runs from the product side: a plain
	 * `localField`/`foreignField` lookup of each product's SKUs, which MongoDB executes in its fast
	 * engine, instead of one sub-pipeline per SKU into `products` (5.3 s → 2.0 s on 100 000 SKUs,
	 * Plan-0010 large-catalogue load). A SKU whose `category_id` differs from its product's is left
	 * out, as before.
	 */
	private skuStages(scopeIds: mongo.ObjectId[]): mongo.Document[] {
		return [
			{ $match: { category_id: { $in: scopeIds } } },
			{ $project: { category_id: 1, attributes_v2: 1, variant_axis: 1, brand_id: 1 } },
			{
				$lookup: {
					from: 'product_variants',
					localField: '_id',
					foreignField: 'product_id',
					as: '_sku'
				}
			},
			{ $unwind: '$_sku' },
			{
				$match: {
					'_sku.status': 'active',
					$expr: { $eq: ['$_sku.category_id', '$category_id'] }
				}
			},
			{
				$replaceWith: {
					$mergeObjects: [
						'$_sku',
						{
							product: {
								_id: '$_id',
								category_id: '$category_id',
								attributes_v2: '$attributes_v2',
								variant_axis: '$variant_axis',
								brand_id: '$brand_id'
							}
						}
					]
				}
			},
			{ $addFields: { _price: effectivePriceExpr(), _attrs: this.attrsExpr() } }
		]
	}

	/**
	 * The same SKUs without the product join — aggregated on `product_variants` — for a scope
	 * where nothing product-level is matched or counted: no characteristic definitions (a group or
	 * the whole catalogue), no brand filter and no branded product in scope. Relies on the writers
	 * keeping `product_variants.category_id` equal to the product's (typed transfer, legacy product
	 * update, migration verify). The page's items get their product fields by `itemProductStages`.
	 */
	private variantStages(
		scopeIds: mongo.ObjectId[],
		drifted: { product_id: mongo.ObjectId; category_id: mongo.ObjectId }[] = []
	): mongo.Document[] {
		return [
			{
				$match: {
					status: 'active',
					category_id: { $in: scopeIds },
					...(drifted.length ? { $nor: drifted } : {})
				}
			},
			{ $addFields: { _price: effectivePriceExpr() } }
		]
	}

	/**
	 * (product, category) pairs of active SKUs in scope whose product is missing or sits in
	 * another category — what the joined path drops. Grouped first, so the lookup runs once per
	 * pair (32 000 for 100 000 SKUs), and compared inside MongoDB so only the drifted pairs —
	 * normally none — reach the API: pulling every pair and product into Node cost ~1.9 GB RSS at
	 * 10 concurrent whole-catalogue reads (Plan-0010 load). The plain lookup runs in the fast
	 * engine; product documents never leave the server.
	 */
	private driftedPairs(scopeIds: mongo.ObjectId[]) {
		return this.connection
			.collection('product_variants')
			.aggregate<{ product_id: mongo.ObjectId; category_id: mongo.ObjectId }>(
				[
					{ $match: { status: 'active', category_id: { $in: scopeIds } } },
					{ $group: { _id: { product_id: '$product_id', category_id: '$category_id' } } },
					{
						$lookup: {
							from: 'products',
							localField: '_id.product_id',
							foreignField: '_id',
							as: 'product'
						}
					},
					{
						$match: {
							$expr: {
								$ne: [
									{ $arrayElemAt: ['$product.category_id', 0] },
									'$_id.category_id'
								]
							}
						}
					},
					{ $replaceWith: '$_id' }
				],
				{ readPreference: 'primary', maxTimeMS: 15000 }
			)
			.toArray()
	}

	/**
	 * Scope-level facts of the variant-only path — whether any product in scope has a brand, and
	 * the drifted pairs — shared by concurrent requests (one query in flight per scope) and reused
	 * for SCOPE_FACTS_MS while the category fingerprint holds. They change only when products move
	 * or get a brand; for that long a listing may still use the variant-only path or keep a pair
	 * excluded, never show a SKU outside its product's category for longer than that.
	 */
	private readonly scopeFacts = new Map<
		string,
		{
			at: number
			facts: Promise<{
				branded: boolean
				drifted: { product_id: mongo.ObjectId; category_id: mongo.ObjectId }[]
			}>
		}
	>()
	private factsOf(key: string, scopeIds: mongo.ObjectId[]) {
		const cached = this.scopeFacts.get(key)
		if (cached && Date.now() - cached.at < SCOPE_FACTS_MS) return cached.facts
		const facts = Promise.all([
			this.connection
				.collection('products')
				.findOne(
					{ category_id: { $in: scopeIds }, brand_id: { $type: 'objectId' } },
					{ projection: { _id: 1 }, readPreference: 'primary' }
				),
			this.driftedPairs(scopeIds)
		]).then(([branded, drifted]) => ({ branded: Boolean(branded), drifted }))
		// A failed query is not remembered.
		facts.catch(() => this.scopeFacts.delete(key))
		if (this.scopeFacts.size > 500) this.scopeFacts.clear()
		this.scopeFacts.set(key, { at: Date.now(), facts })
		return facts
	}

	/** Product fields of the page's items only (after `$limit`) on the variant-only path. */
	private itemProductStages(): mongo.Document[] {
		return [
			{
				$lookup: {
					from: 'products',
					localField: 'product_id',
					foreignField: '_id',
					as: 'product',
					pipeline: [{ $project: { attributes_v2: 1, variant_axis: 1, brand_id: 1 } }]
				}
			},
			{ $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
			{ $addFields: { _attrs: this.attrsExpr() } }
		]
	}

	/**
	 * Active SKUs each typed landing of one v2 product category pins (`filters_v2`), in one
	 * aggregation. Landings whose pins no longer fit the category's definitions count 0.
	 */
	async countTypedLandings(categoryId: string, landings: { id: string; filters: unknown }[]) {
		const counts = new Map<string, number>()
		if (!landings.length) return counts
		// Read directly, not through the public read barrier: the landing writer counts inside its
		// own gate operation (publishing needs a non-empty landing), where the barrier would answer
		// «catalogue busy». Visibility is the caller's concern.
		const row = /^[a-f0-9]{24}$/i.test(categoryId)
			? await this.connection
					.collection('categories')
					.findOne({ _id: new mongo.ObjectId(categoryId) }, { readPreference: 'primary' })
			: null
		const category = row
			? readCategoryConfiguration({
					...row,
					parent_id: row.parent_id == null ? null : String(row.parent_id)
				})
			: null
		if (
			!row ||
			!category ||
			category.kind !== 'product' ||
			category.attribute_contract_version !== 2
		)
			return new Map(landings.map(landing => [landing.id, 0]))
		const facets: Record<string, mongo.Document[]> = {}
		for (const [index, landing] of landings.entries()) {
			try {
				const conditions = [
					...this.conditionsOf(
						parseCatalogFilters(landing.filters),
						category.attribute_definitions!
					).values()
				]
				facets[`l${index}`] = [
					...(conditions.length ? [{ $match: { $and: conditions } }] : []),
					{ $count: 'count' }
				]
			} catch {
				counts.set(landing.id, 0)
			}
		}
		if (!Object.keys(facets).length) return counts
		const [result] = await this.connection
			.collection('products')
			.aggregate<Record<string, { count: number }[]>>(
				[...this.skuStages([row._id]), { $facet: facets }],
				{ readPreference: 'primary', maxTimeMS: 15000 }
			)
			.toArray()
		for (const [index, landing] of landings.entries())
			if (!counts.has(landing.id))
				counts.set(landing.id, result[`l${index}`]?.[0]?.count ?? 0)
		return counts
	}
}
