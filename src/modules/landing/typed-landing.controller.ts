import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
	BadRequestException,
	Body,
	ConflictException,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Injectable,
	NotFoundException,
	Param,
	Patch,
	Post,
	Query,
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
	ApiQuery,
	ApiResponse,
	ApiTags
} from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { PublicCatalogService } from '../product/public-catalog.service'
import { TypedLandingError, TypedLandingWriter } from './typed-landing-writer'

const filtersDoc = {
	type: 'object' as const,
	description:
		'Catalogue filters object of `GET /products/catalog/v2` (`attributes`, `color_families`, `brand_ids`, `price`); at least one attribute, colour or brand pin.',
	additionalProperties: true
}
export class TypedLandingBodyDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
	@ApiProperty({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 200 }) slug!: string
	@ApiProperty({ maxLength: 300 }) h1!: string
	@ApiProperty({ maxLength: 300 }) title!: string
	@ApiProperty({ maxLength: 1000 }) meta_description!: string
	@ApiProperty({ required: false, description: 'Sanitized rich text above the grid' })
	intro_html?: string
	@ApiProperty({ required: false, description: 'Sanitized rich text below the grid' })
	bottom_html?: string
	@ApiProperty({
		required: false,
		type: 'array',
		items: {
			type: 'object',
			required: ['q', 'a'],
			properties: { q: { type: 'string' }, a: { type: 'string' } }
		}
	})
	faq?: { q: string; a: string }[]
	@ApiProperty(filtersDoc) filters_v2!: Record<string, unknown>
	@ApiProperty({ type: String, nullable: true, required: false }) image?: string | null
	@ApiProperty({ required: false, minimum: 0 }) order?: number
	@ApiProperty({ required: false, enum: ['draft', 'active'] }) status?: 'draft' | 'active'
}
export class TypedLandingCreateDto extends TypedLandingBodyDto {
	@ApiProperty({ pattern: '^[a-f0-9]{24}$' }) category_id!: string
}
export class TypedLandingRevisionDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
}
export class TypedLandingReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() landing_id!: string
}
export class TypedLandingItemDto {
	@ApiProperty() _id!: string
	@ApiProperty() category_id!: string
	@ApiProperty() slug!: string
	@ApiProperty() h1!: string
	@ApiProperty() title!: string
	@ApiProperty() meta_description!: string
	@ApiProperty() intro_html!: string
	@ApiProperty() bottom_html!: string
	@ApiProperty({ type: 'array', items: { type: 'object' } }) faq!: { q: string; a: string }[]
	@ApiProperty({ ...filtersDoc, nullable: true }) filters_v2!: Record<string, unknown> | null
	@ApiProperty({ type: Number, nullable: true }) contract_version!: number | null
	@ApiProperty({ type: String, nullable: true }) image!: string | null
	@ApiProperty() order!: number
	@ApiProperty({ enum: ['draft', 'active'] }) status!: string
	@ApiProperty({ description: 'Active SKUs the pins match (the storefront count)' })
	product_count!: number
}
/** Landings of one category the admin list carries; above it `truncated` says so (P06). */
export const TYPED_LANDING_LIST_MAX = 500
/** The stored `landings` fields the admin list reads (optional ones may be absent on old rows). */
type TypedLandingRow = {
	category_id: mongo.ObjectId
	slug: string
	h1: string
	title: string
	meta_description: string
	intro_html?: string | null
	bottom_html?: string | null
	faq?: { q: string; a: string }[] | null
	filters_v2?: Record<string, unknown> | null
	contract_version?: number | null
	image?: string | null
	order?: number | null
	status: string
}
export class TypedLandingListDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty({ type: [TypedLandingItemDto], maxItems: TYPED_LANDING_LIST_MAX })
	items!: TypedLandingItemDto[]
	@ApiProperty({
		description: `true when the category has more than ${TYPED_LANDING_LIST_MAX} landings: only the first are listed (by order)`
	})
	truncated!: boolean
}

@Injectable()
export class TypedLandingService {
	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly catalog: PublicCatalogService
	) {}
	private writer() {
		return new TypedLandingWriter(this.connection.db!, async (categoryId, filters) => {
			const counts = await this.catalog.countTypedLandings(categoryId, [
				{ id: 'candidate', filters }
			])
			return counts.get('candidate') ?? 0
		})
	}
	/** Every landing of one v2 product category (drafts too) with its typed storefront count. */
	async list(input: unknown) {
		const parsed = z
			.strictObject({ category_id: z.string().regex(/^[a-f0-9]{24}$/i) })
			.safeParse(input)
		if (!parsed.success) throw new BadRequestException('Invalid category')
		const categoryId = parsed.data.category_id.toLowerCase()
		const db = this.connection.db!
		const gate = new CatalogWriteGate(db)
		const stamp = await gate.readStamp()
		const category = await db
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(categoryId) }, { readPreference: 'primary' })
		if (!category) throw new NotFoundException('Category not found')
		if (category.attribute_contract_version !== 2 || category.kind !== 'product')
			throw new ConflictException({
				message: 'Посадкові сторінки нового каталогу — лише для товарної категорії v2',
				details: { code: 'LANDING_CATEGORY_INVALID' }
			})
		const rows = await db
			.collection<TypedLandingRow>('landings')
			.find({ category_id: category._id }, { readPreference: 'primary' })
			.sort({ order: 1, _id: 1 })
			.limit(TYPED_LANDING_LIST_MAX + 1)
			.toArray()
		const truncated = rows.length > TYPED_LANDING_LIST_MAX
		if (truncated) rows.length = TYPED_LANDING_LIST_MAX
		const typed = rows.filter(row => row.contract_version === 2 && row.filters_v2)
		const counts = await this.catalog.countTypedLandings(
			categoryId,
			typed.map(row => ({ id: String(row._id), filters: row.filters_v2 }))
		)
		await gate.assertReadUnchanged(stamp)
		return {
			category_id: categoryId,
			revision: stamp.revision,
			items: rows.map(row => ({
				_id: String(row._id),
				category_id: categoryId,
				slug: row.slug,
				h1: row.h1,
				title: row.title,
				meta_description: row.meta_description,
				intro_html: row.intro_html ?? '',
				bottom_html: row.bottom_html ?? '',
				faq: row.faq ?? [],
				filters_v2: row.filters_v2 ?? null,
				contract_version: row.contract_version ?? null,
				image: row.image ?? null,
				order: row.order ?? 0,
				status: row.status,
				product_count: counts.get(String(row._id)) ?? 0
			})),
			truncated
		}
	}
	async create(key: string | undefined, body: unknown) {
		return this.write(key, body, (writer, request, command) => writer.create(request, command))
	}
	async update(id: string, key: string | undefined, body: unknown) {
		this.id(id)
		return this.write(key, body, (writer, request, command) =>
			writer.update(request, id.toLowerCase(), command)
		)
	}
	async remove(id: string, key: string | undefined, body: unknown) {
		this.id(id)
		return this.write(key, body, (writer, request) => writer.remove(request, id.toLowerCase()))
	}
	private id(id: string) {
		if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Invalid landing ID')
	}
	private async write(
		key: string | undefined,
		body: unknown,
		action: (
			writer: TypedLandingWriter,
			request: { operationId: string; ownerId: string; expectedRevision: number },
			command: Record<string, unknown>
		) => Promise<unknown>
	) {
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const { expected_revision, ...command } = z
				.looseObject({ expected_revision: z.number().int().nonnegative().safe() })
				.parse(body)
			const receipt = await action(
				this.writer(),
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: expected_revision
				},
				command
			)
			storefrontRevalidation.revalidate('landings', 'typed landing')
			return receipt
		} catch (error) {
			const code =
				error instanceof CatalogGateError || error instanceof TypedLandingError
					? error.code
					: error instanceof z.ZodError
						? 'INVALID_LANDING_FIELDS'
						: error instanceof Error && error.name === 'CatalogJournalError'
							? (error as Error & { code: string }).code
							: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
			const response = {
				message: 'Не вдалося зберегти посадкову сторінку',
				details: { code, operation_id: uuid.data.toLowerCase() }
			}
			if (
				[
					'INVALID_LANDING_FIELDS',
					'LANDING_FILTERS_INVALID',
					'LANDING_PINS_REQUIRED'
				].includes(code)
			)
				throw new BadRequestException(response)
			if (['LANDING_NOT_FOUND', 'CATEGORY_NOT_FOUND'].includes(code))
				throw new NotFoundException(response)
			if (
				[
					'LANDING_CATEGORY_INVALID',
					'LANDING_SLUG_TAKEN',
					'LANDING_SLUG_LOCKED',
					'LANDING_FILTERS_DUPLICATE',
					'LANDING_HAS_NO_PRODUCTS',
					'LANDING_UNCHANGED',
					'LANDING_DELETE_REQUIRES_DRAFT',
					'LANDING_IN_USE',
					'CATEGORY_REVISION_CONFLICT',
					'IDEMPOTENCY_KEY_REUSED',
					'OPERATION_ALREADY_REGISTERED'
				].includes(code)
			)
				throw new ConflictException(response)
			throw new ServiceUnavailableException(response)
		}
	}
}

@Controller(ENDPOINTS.LANDINGS.BASE)
@ApiTags(ENDPOINTS.LANDINGS.BASE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class TypedLandingController {
	constructor(private readonly service: TypedLandingService) {}
	@Get(ENDPOINTS.LANDINGS.TYPED_ADMIN)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.LANDINGS.TYPED_ADMIN_LIST)
	@ApiQuery({ name: 'category_id', required: true, type: String })
	@ApiOkResponse({ type: TypedLandingListDto })
	@ApiResponse({ status: 400, description: 'Invalid category id' })
	@ApiResponse({ status: 404, description: 'Category missing' })
	@ApiResponse({
		status: 409,
		description: 'LANDING_CATEGORY_INVALID — not a v2 product category'
	})
	@ApiResponse({ status: 503, description: 'Catalog busy or changed during the read' })
	list(@Query() query: Record<string, unknown>) {
		return this.service.list(query)
	}
	@Post(ENDPOINTS.LANDINGS.TYPED_ADMIN)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.LANDINGS.TYPED_ADMIN_CREATE)
	@ApiBody({ type: TypedLandingCreateDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiResponse({ status: 201, type: TypedLandingReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid fields or pins' })
	@ApiResponse({ status: 404, description: 'CATEGORY_NOT_FOUND' })
	@ApiResponse({
		status: 409,
		description: 'Slug taken, duplicate pins, empty on publish, revision'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	create(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
		return this.service.create(key, body)
	}
	@Patch(ENDPOINTS.LANDINGS.TYPED_ADMIN_ITEM)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.LANDINGS.TYPED_ADMIN_UPDATE)
	@ApiBody({ type: TypedLandingBodyDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: TypedLandingReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid fields or pins' })
	@ApiResponse({ status: 404, description: 'Landing missing' })
	@ApiResponse({
		status: 409,
		description: 'Slug taken, duplicate pins, empty on publish, unchanged, revision'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	update(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.update(id, key, body)
	}
	@Post(ENDPOINTS.LANDINGS.TYPED_ADMIN_DELETION)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.LANDINGS.TYPED_ADMIN_DELETE)
	@ApiBody({ type: TypedLandingRevisionDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: TypedLandingReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid landing id, body or Idempotency-Key' })
	@ApiResponse({ status: 404, description: 'Landing missing' })
	@ApiResponse({
		status: 409,
		description: 'Only a draft typed landing is deleted; revision conflict'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	remove(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.remove(id, key, body)
	}
}
