import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
	BadRequestException,
	Body,
	ConflictException,
	Controller,
	Get,
	Header,
	Headers,
	Injectable,
	NotFoundException,
	Patch,
	ServiceUnavailableException,
	UseGuards
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection, mongo } from 'mongoose'
import {
	ApiBody,
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiResponse,
	ApiTags
} from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { sanitizePlainText } from 'src/common/utils/html.utils'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { runCatalogOperation } from 'src/database/mongoose/repositories/catalog-operation'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { CatalogConsistentRead } from '../catalog-safety/legacy-catalog-write.interceptor'
import { STOREFRONT_LIMITS } from './storefront-limits'

/**
 * Storefront settings (Plan-0010 B09, TD-0015): the home page's copy — the strip above the header,
 * the banner, the card beside it and the band between the strips — and curated collections (a
 * category or one of its typed landings, or a product list). No product or category is written into
 * the storefront's code (owner, 2026-11-08: «ніякого хардкоду»): until the admin saves the copy, the
 * defaults below answer, and they are edited like any other value. The home page's category tiles
 * (`home_category_ids`) are gone: its menu is the public category tree (TD-0015, 2026-11-09). One
 * document, written through the catalogue gate and journal (profile `settings`) because collections
 * reference categories and landings — the category deletion already refuses a referenced one.
 * Readers get a sanitized projection of visible targets only.
 */
export const STOREFRONT_SETTINGS_ID = '00000000000000000000aa01'
const objectId = z.string().regex(/^[a-f0-9]{24}$/i)
/**
 * A button goes somewhere on this site: one leading slash, no scheme, no `//host`, no spaces — and
 * no backslash anywhere: a browser reads `/\host` as `//host`, off the site (audit 11.11).
 */
const internalHref = z
	.string()
	.trim()
	.max(300)
	.regex(/^\/(?!\/)[^\s\\]*$/, 'INTERNAL_HREF_REQUIRED')
const line = (max: number) => z.string().trim().max(max)
const required = (max: number) => z.string().trim().min(1).max(max)
export const storefrontContentSchema = z.strictObject({
	/** The thin strip above the header: up to four short promises; none — no strip. */
	strip: z.array(required(60)).max(4),
	/** The home page's banner; its title is the page's H1, `accent` the highlighted part of it. */
	banner: z
		.strictObject({
			eyebrow: line(60),
			title: required(80),
			accent: line(80),
			text: line(200),
			button_label: required(40),
			button_href: internalHref
		})
		.refine(banner => !banner.accent || banner.title.includes(banner.accent), {
			message: 'BANNER_ACCENT_NOT_IN_TITLE',
			path: ['accent']
		}),
	/** The card beside the banner: the wholesale inquiry form, or a link on this site. */
	side_promo: z
		.strictObject({
			title: required(60),
			text: line(160),
			button_label: required(40),
			action: z.enum(['wholesale-form', 'link']),
			button_href: internalHref.nullable()
		})
		.refine(card => (card.action === 'link') === (card.button_href !== null), {
			message: 'SIDE_PROMO_HREF',
			path: ['button_href']
		}),
	/** The band between the strips; `null` — none. */
	band: z
		.strictObject({
			title: required(60),
			text: line(160),
			button_label: required(40),
			button_href: internalHref
		})
		.nullable()
})
export type StorefrontContent = z.infer<typeof storefrontContentSchema>
/** What answers until the admin saves the copy (TD-0015 sketch) — data, edited in «Вітрина». */
export const STOREFRONT_CONTENT_DEFAULTS: StorefrontContent = {
	strip: [
		'Відправляємо Новою Поштою щодня',
		'Доставка 1–3 дні',
		'Консультація 7 днів на тиждень'
	],
	banner: {
		eyebrow: 'Fillando',
		title: 'Усе для того, що ви створюєте',
		accent: 'створюєте',
		text: 'Ціни й наявність видно одразу. Відправляємо Новою Поштою щодня.',
		button_label: 'До каталогу',
		button_href: '/catalog'
	},
	side_promo: {
		title: 'Купуєте оптом?',
		text: 'Залиште заявку — підготуємо ціни й умови для вашого бізнесу.',
		button_label: 'Заповнити форму',
		action: 'wholesale-form',
		button_href: null
	},
	band: {
		title: 'Прайс-лист',
		text: 'Усі товари з цінами й наявністю на одній сторінці.',
		button_label: 'Відкрити прайс-лист',
		button_href: '/price-sheet'
	}
}
const CONTENT_KEYS = ['strip', 'banner', 'side_promo', 'band'] as const
/** The stored copy, each part falling back to its default until it is saved. */
function contentOf(row: mongo.Document | null): StorefrontContent {
	return Object.fromEntries(
		CONTENT_KEYS.map(key => [
			key,
			row && Object.hasOwn(row, key) ? row[key] : STOREFRONT_CONTENT_DEFAULTS[key]
		])
	) as StorefrontContent
}
/** Plain text only — the storefront renders these as text, never as markup. */
function sanitizeContent(content: StorefrontContent): StorefrontContent {
	const text = (value: string) => sanitizePlainText(value)
	return {
		strip: content.strip.map(text),
		banner: {
			...content.banner,
			eyebrow: text(content.banner.eyebrow),
			title: text(content.banner.title),
			accent: text(content.banner.accent),
			text: text(content.banner.text),
			button_label: text(content.banner.button_label)
		},
		side_promo: {
			...content.side_promo,
			title: text(content.side_promo.title),
			text: text(content.side_promo.text),
			button_label: text(content.side_promo.button_label)
		},
		band: content.band && {
			...content.band,
			title: text(content.band.title),
			text: text(content.band.text),
			button_label: text(content.band.button_label)
		}
	}
}
export const storefrontSettingsSchema = storefrontContentSchema.extend({
	collections: z
		.array(
			z
				.strictObject({
					id: z.string().uuid().optional(),
					title: z.string().trim().min(1).max(120),
					/** A category (optionally one of its typed landings)… */
					category_id: objectId.nullable().default(null),
					landing_id: objectId.nullable().default(null),
					/** …or an explicit list of products, in the admin's order. */
					product_ids: z
						.array(objectId)
						.max(STOREFRONT_LIMITS.collectionProducts)
						.default([])
				})
				.refine(
					row =>
						row.product_ids.length
							? row.category_id === null && row.landing_id === null
							: row.category_id !== null,
					{ message: 'COLLECTION_SOURCE_INVALID' }
				)
		)
		.max(STOREFRONT_LIMITS.collections)
})
type Settings = StorefrontContent & {
	collections: {
		id: string
		title: string
		category_id: mongo.ObjectId | null
		landing_id: mongo.ObjectId | null
		product_ids?: mongo.ObjectId[]
	}[]
}

export class StorefrontSettingsError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'StorefrontSettingsError'
	}
}

export class StorefrontSettingsWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'settings')
	}
	private document() {
		return this.db
			.collection('storefront_settings')
			.findOne(
				{ _id: new mongo.ObjectId(STOREFRONT_SETTINGS_ID) },
				{ readPreference: 'primary' }
			)
	}
	async read() {
		const stamp = await this.gate.readStamp()
		const row = await this.document()
		await this.gate.assertReadUnchanged(stamp)
		return {
			revision: stamp.revision,
			...contentOf(row),
			collections: ((row?.collections ?? []) as Settings['collections']).map(item => ({
				id: item.id,
				title: item.title,
				category_id: item.category_id ? String(item.category_id) : null,
				landing_id: item.landing_id ? String(item.landing_id) : null,
				product_ids: (item.product_ids ?? []).map(String)
			}))
		}
	}
	/** References must exist now: v2 categories that are not archived, typed landings of their category. */
	private async resolve(input: z.infer<typeof storefrontSettingsSchema>): Promise<Settings> {
		const ids = [
			...new Set(input.collections.flatMap(row => (row.category_id ? [row.category_id] : [])))
		]
		const categories = await this.db
			.collection('categories')
			.find(
				{ _id: { $in: ids.map(id => new mongo.ObjectId(id)) } },
				{
					projection: { attribute_contract_version: 1, status: 1 },
					readPreference: 'primary'
				}
			)
			.toArray()
		const usable = new Set(
			categories
				.filter(row => row.attribute_contract_version === 2 && row.status !== 'archived')
				.map(row => String(row._id))
		)
		if (ids.some(id => !usable.has(id.toLowerCase())))
			throw new StorefrontSettingsError('SETTINGS_CATEGORY_INVALID')
		// Listed products must exist in a v2 category that is not archived; each once per collection.
		const productIds = [
			...new Set(
				input.collections.flatMap(row => row.product_ids.map(id => id.toLowerCase()))
			)
		]
		if (productIds.length) {
			const products = await this.db
				.collection('products')
				.find(
					{ _id: { $in: productIds.map(id => new mongo.ObjectId(id)) } },
					{ projection: { category_id: 1 }, readPreference: 'primary' }
				)
				.toArray()
			const homes = await this.db
				.collection('categories')
				.find(
					{ _id: { $in: products.map(row => row.category_id as mongo.ObjectId) } },
					{
						projection: { attribute_contract_version: 1, status: 1 },
						readPreference: 'primary'
					}
				)
				.toArray()
			const typed = new Set(
				homes
					.filter(
						row => row.attribute_contract_version === 2 && row.status !== 'archived'
					)
					.map(row => String(row._id))
			)
			if (
				products.length !== productIds.length ||
				products.some(row => !typed.has(String(row.category_id)))
			)
				throw new StorefrontSettingsError('SETTINGS_PRODUCT_INVALID')
		}
		if (
			input.collections.some(
				row =>
					new Set(row.product_ids.map(id => id.toLowerCase())).size !==
					row.product_ids.length
			)
		)
			throw new StorefrontSettingsError('SETTINGS_DUPLICATE_PRODUCT')
		for (const row of input.collections)
			if (row.landing_id && row.category_id) {
				const landing = await this.db.collection('landings').findOne(
					{
						_id: new mongo.ObjectId(row.landing_id),
						category_id: new mongo.ObjectId(row.category_id),
						contract_version: 2
					},
					{ projection: { _id: 1 }, readPreference: 'primary' }
				)
				if (!landing) throw new StorefrontSettingsError('SETTINGS_LANDING_INVALID')
			}
		return {
			...sanitizeContent({
				strip: input.strip,
				banner: input.banner,
				side_promo: input.side_promo,
				band: input.band
			}),
			collections: input.collections.map(row => ({
				id: row.id ?? randomUUID(),
				title: sanitizePlainText(row.title),
				category_id: row.category_id ? new mongo.ObjectId(row.category_id) : null,
				landing_id: row.landing_id ? new mongo.ObjectId(row.landing_id) : null,
				// Stored only on a product collection: a category collection keeps its old shape.
				...(row.product_ids.length
					? { product_ids: row.product_ids.map(id => new mongo.ObjectId(id)) }
					: {})
			}))
		}
	}
	async write(
		request: { operationId: string; ownerId: string; expectedRevision: number },
		input: unknown
	) {
		const command = storefrontSettingsSchema.parse(input)
		const { db, gate, journal } = this
		return runCatalogOperation(
			{ db, gate, journal },
			{
				request,
				hashed: {
					type: 'storefront-settings',
					expected_revision: request.expectedRevision,
					command
				},
				receipt: {},
				build: () => this.plan(command)
			}
		)
	}
	/** The save as a patch of the settings document; refuses one that changes nothing. */
	private async plan(command: z.infer<typeof storefrontSettingsSchema>): Promise<CatalogPatch[]> {
		const next = await this.resolve(command)
		const current = await this.document()
		// Collections keep their ids across saves; a re-sent list without ids gets new ones,
		// so compare without them.
		const comparable = (value: Partial<Settings>) => ({
			...contentOf(value),
			collections: (value.collections ?? []).map(row => ({
				title: row.title,
				category_id: row.category_id ? String(row.category_id) : null,
				landing_id: row.landing_id ? String(row.landing_id) : null,
				product_ids: (row.product_ids ?? []).map(String)
			}))
		})
		if (
			current &&
			!Object.hasOwn(current, 'home_category_ids') &&
			isDeepStrictEqual(comparable(current as Partial<Settings>), comparable(next))
		)
			throw new StorefrontSettingsError('SETTINGS_UNCHANGED')
		const now = new Date()
		const patch: CatalogPatch = current
			? {
					collection: 'storefront_settings',
					id: STOREFRONT_SETTINGS_ID,
					fields: {
						...Object.fromEntries(
							Object.entries({ ...next, updatedAt: now }).map(([key, value]) => [
								key,
								{
									before: Object.hasOwn(current, key)
										? { exists: true, value: current[key] as unknown }
										: { exists: false },
									after: { exists: true, value }
								}
							])
						),
						// The home page's tiles are gone (TD-0015): a save drops the old field.
						...(Object.hasOwn(current, 'home_category_ids')
							? {
									home_category_ids: {
										before: {
											exists: true,
											value: current.home_category_ids as unknown
										},
										after: { exists: false }
									}
								}
							: {})
					}
				}
			: {
					collection: 'storefront_settings',
					id: STOREFRONT_SETTINGS_ID,
					fields: {},
					creation: {
						_id: new mongo.ObjectId(STOREFRONT_SETTINGS_ID),
						...next,
						createdAt: now,
						updatedAt: now
					}
				}
		return [patch]
	}
}

class SettingsCollectionDto {
	@ApiProperty({
		required: false,
		format: 'uuid',
		description: 'Kept across saves; omit for a new one'
	})
	id?: string
	@ApiProperty({ maxLength: 120 }) title!: string
	@ApiProperty({
		type: String,
		nullable: true,
		pattern: '^[a-f0-9]{24}$',
		description: 'The category of a category/landing collection; null for a product list'
	})
	category_id!: string | null
	@ApiProperty({ type: String, nullable: true, pattern: '^[a-f0-9]{24}$' }) landing_id!:
		| string
		| null
	@ApiProperty({
		type: [String],
		required: false,
		maxItems: STOREFRONT_LIMITS.collectionProducts,
		description: 'Explicit products in order (then category_id and landing_id are null)'
	})
	product_ids?: string[]
}
class BannerDto {
	@ApiProperty({ maxLength: 60 }) eyebrow!: string
	@ApiProperty({ maxLength: 80, description: 'The home page H1' }) title!: string
	@ApiProperty({
		maxLength: 80,
		description: 'A part of `title` shown highlighted; may be empty'
	})
	accent!: string
	@ApiProperty({ maxLength: 200 }) text!: string
	@ApiProperty({ maxLength: 40 }) button_label!: string
	@ApiProperty({ maxLength: 300, description: 'A path on this site, starting with `/`' })
	button_href!: string
}
class SidePromoDto {
	@ApiProperty({ maxLength: 60 }) title!: string
	@ApiProperty({ maxLength: 160 }) text!: string
	@ApiProperty({ maxLength: 40 }) button_label!: string
	@ApiProperty({ enum: ['wholesale-form', 'link'] }) action!: 'wholesale-form' | 'link'
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'A path on this site with `link`; null with `wholesale-form`'
	})
	button_href!: string | null
}
class BandDto {
	@ApiProperty({ maxLength: 60 }) title!: string
	@ApiProperty({ maxLength: 160 }) text!: string
	@ApiProperty({ maxLength: 40 }) button_label!: string
	@ApiProperty({ maxLength: 300, description: 'A path on this site, starting with `/`' })
	button_href!: string
}
class StorefrontContentDto {
	@ApiProperty({
		type: [String],
		maxItems: 4,
		description: 'Up to four short lines; none — no strip'
	})
	strip!: string[]
	@ApiProperty({ type: BannerDto }) banner!: BannerDto
	@ApiProperty({ type: SidePromoDto }) side_promo!: SidePromoDto
	@ApiProperty({ type: BandDto, nullable: true, description: 'null — no band' })
	band!: BandDto | null
}
export class StorefrontSettingsWriteDto extends StorefrontContentDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
	@ApiProperty({ type: [SettingsCollectionDto], maxItems: STOREFRONT_LIMITS.collections })
	collections!: SettingsCollectionDto[]
}
export class StorefrontSettingsAdminDto extends StorefrontContentDto {
	@ApiProperty() revision!: number
	@ApiProperty({ type: [SettingsCollectionDto] }) collections!: SettingsCollectionDto[]
}
type PublicCollection = {
	id: string
	title: string
	category_id: string | null
	path: string | null
	filters: Record<string, unknown> | null
}
class PublicCollectionDto {
	@ApiProperty() id!: string
	@ApiProperty() title!: string
	@ApiProperty({ type: String, nullable: true, description: 'null for a product list' })
	category_id!: string | null
	@ApiProperty({ type: String, nullable: true, description: 'null for a product list' })
	path!: string | null
	@ApiProperty({
		type: 'object',
		nullable: true,
		additionalProperties: true,
		description:
			'Catalogue filters for `GET /products/catalog/v2`: the landing pins (`filters_v2`), or `{product_ids}` of a product list (visible products only)'
	})
	filters!: Record<string, unknown> | null
}
export class StorefrontSettingsPublicDto extends StorefrontContentDto {
	@ApiProperty({ type: [PublicCollectionDto] }) collections!: PublicCollectionDto[]
}

@Injectable()
export class StorefrontSettingsService {
	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly categories: CategoryPublicReadService
	) {}
	/** What a shopper may see: visible categories, active typed landings of visible categories. */
	async publicSettings() {
		const row = await this.connection
			.collection('storefront_settings')
			.findOne({ _id: new mongo.ObjectId(STOREFRONT_SETTINGS_ID) })
		if (!row) return { ...STOREFRONT_CONTENT_DEFAULTS, collections: [] }
		const tree = await this.categories.findVisibleTree()
		const visible = new Map(tree.map(node => [node._id, node]))
		const landingIds = ((row.collections ?? []) as Settings['collections'])
			.map(item => item.landing_id)
			.filter((id): id is mongo.ObjectId => id instanceof mongo.ObjectId)
		const landings = new Map(
			(
				await this.connection
					.collection('landings')
					.find({ _id: { $in: landingIds }, status: 'active', contract_version: 2 })
					.toArray()
			).map(landing => [String(landing._id), landing])
		)
		const listed = ((row.collections ?? []) as Settings['collections']).flatMap(
			item => item.product_ids ?? []
		)
		const visibleProducts = new Set(
			listed.length
				? (
						await this.connection
							.collection('products')
							.find(
								{
									_id: { $in: listed },
									category_id: {
										$in: [...visible.values()]
											.filter(node => node.kind === 'product')
											.map(node => new mongo.ObjectId(node._id))
									}
								},
								{ projection: { _id: 1 } }
							)
							.toArray()
					).map(product => String(product._id))
				: []
		)
		return {
			...contentOf(row),
			collections: ((row.collections ?? []) as Settings['collections']).flatMap(
				(item): PublicCollection[] => {
					// A product list: only products of visible categories; nothing visible, no strip.
					if (item.product_ids?.length) {
						const shown = item.product_ids
							.map(String)
							.filter(id => visibleProducts.has(id))
						return shown.length
							? [
									{
										id: item.id,
										title: item.title,
										category_id: null,
										path: null,
										filters: { product_ids: shown }
									}
								]
							: []
					}
					const category = visible.get(String(item.category_id))
					if (!category) return []
					const landing = item.landing_id
						? landings.get(String(item.landing_id))
						: undefined
					// A landing that is no longer public falls back to its category, never to a 404.
					return [
						{
							id: item.id,
							title: item.title,
							category_id: category._id,
							path: landing
								? `/${category.slug}/${landing.slug as string}`
								: `/${category.slug}`,
							filters: landing
								? ((landing.filters_v2 ?? null) as Record<string, unknown> | null)
								: null
						}
					]
				}
			)
		}
	}
	async adminSettings() {
		try {
			return await new StorefrontSettingsWriter(this.connection.db!).read()
		} catch (error) {
			this.fail(error)
		}
	}
	async write(key: string | undefined, body: unknown) {
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const { expected_revision, ...command } = z
				.looseObject({ expected_revision: z.number().int().nonnegative().safe() })
				.parse(body)
			const receipt = await new StorefrontSettingsWriter(this.connection.db!).write(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: expected_revision
				},
				command
			)
			// The storefront reads the settings with the categories tag (home, /catalog).
			storefrontRevalidation.revalidate('categories', 'storefront settings')
			return receipt
		} catch (error) {
			this.fail(error, uuid.data.toLowerCase())
		}
	}
	private fail(error: unknown, operation_id?: string): never {
		const code =
			error instanceof CatalogGateError || error instanceof StorefrontSettingsError
				? error.code
				: error instanceof z.ZodError
					? 'INVALID_SETTINGS_FIELDS'
					: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
		const body = {
			message: 'Не вдалося зберегти налаштування вітрини',
			details: { code, operation_id }
		}
		if (code === 'INVALID_SETTINGS_FIELDS') throw new BadRequestException(body)
		if (
			[
				'SETTINGS_CATEGORY_INVALID',
				'SETTINGS_LANDING_INVALID',
				'SETTINGS_PRODUCT_INVALID',
				'SETTINGS_DUPLICATE_PRODUCT',
				'SETTINGS_UNCHANGED',
				'CATEGORY_REVISION_CONFLICT',
				'IDEMPOTENCY_KEY_REUSED',
				'OPERATION_ALREADY_REGISTERED'
			].includes(code)
		)
			throw new ConflictException(body)
		if (code === 'NOT_FOUND') throw new NotFoundException(body)
		throw new ServiceUnavailableException(body)
	}
}

@Controller(ENDPOINTS.STOREFRONT_SETTINGS.BASE)
@ApiTags(ENDPOINTS.STOREFRONT_SETTINGS.BASE)
export class StorefrontSettingsController {
	constructor(private readonly service: StorefrontSettingsService) {}
	@Get()
	@CatalogConsistentRead()
	@ApiOperation(API_OPERATION.STOREFRONT_SETTINGS.PUBLIC)
	@ApiOkResponse({ type: StorefrontSettingsPublicDto })
	@ApiResponse({ status: 503, description: 'Catalogue maintenance or a change during the read' })
	publicSettings() {
		return this.service.publicSettings()
	}
	@Get(ENDPOINTS.STOREFRONT_SETTINGS.ADMIN)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.STOREFRONT_SETTINGS.ADMIN_READ)
	@ApiOkResponse({ type: StorefrontSettingsAdminDto })
	adminSettings() {
		return this.service.adminSettings()
	}
	@Patch()
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.STOREFRONT_SETTINGS.WRITE)
	@ApiBody({ type: StorefrontSettingsWriteDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiResponse({ status: 200, description: '`{operation_id, revision}`' })
	@ApiResponse({ status: 400, description: 'Invalid fields' })
	@ApiResponse({
		status: 409,
		description:
			'Unknown/archived/v1 category, landing of another category, unchanged, revision'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	write(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
		return this.service.write(key, body)
	}
}
