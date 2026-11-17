import { createHash, randomUUID } from 'node:crypto'
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
	HttpCode,
	Injectable,
	NotFoundException,
	Param,
	Patch,
	Post,
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
import { ColorFamily, Role } from 'src/common/types/enums'
import { generateSlug } from 'src/common/utils'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogJournalError,
	CatalogMutationJournal,
	CatalogPatch,
	PLAN_MAX_TARGETS
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { formatColorLabel, variantName } from 'src/modules/product/product.service'
import { HEX_STOP_PATTERN } from './dto/create-color.dto'

/**
 * The colour dictionary in the new admin (Plan-0010, «не гірше за стару адмінку»). After the
 * catalogue control exists the legacy `/colors` writes are interlocked, so without this nobody
 * could add a new filament colour. Same rules as `ColorService`, through the gate and journal:
 * an edit and what SKUs denormalize from it (`color_family`, the «товар — Чорний (Black)» name)
 * are one plan, so a failure leaves nothing half-renamed; `v_value` and slugs never change.
 */
export const colorEntrySchema = z.strictObject({
	name_en: z.string().trim().min(1).max(100),
	name_uk: z.string().trim().min(1).max(100),
	/** Create: omitted → derived from `name_en`. Update: the stored one if omitted. */
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.max(100)
		.optional(),
	family: z.nativeEnum(ColorFamily),
	hex_stops: z.array(z.string().regex(HEX_STOP_PATTERN)).min(1).max(6),
	order: z.number().int().nonnegative().safe().optional()
})
export type ColorEntry = z.infer<typeof colorEntrySchema>
/** A plan touches the colour and its SKUs; the journal bounds one plan to 500 targets. */

export class ColorAdminError extends Error {
	constructor(
		readonly code: string,
		readonly count?: number
	) {
		super(code)
		this.name = 'ColorAdminError'
	}
}

export class ColorAdminWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'colors')
	}

	async read() {
		const stamp = await this.gate.readStamp()
		const [colors, counts] = await Promise.all([
			this.db
				.collection('colors')
				.find({}, { readPreference: 'primary' })
				.sort({ order: 1, name_en: 1 })
				.toArray(),
			this.db
				.collection('product_variants')
				.aggregate<{ _id: mongo.ObjectId; count: number }>(
					[
						{ $match: { color_id: { $ne: null } } },
						{ $group: { _id: '$color_id', count: { $sum: 1 } } }
					],
					{ readPreference: 'primary' }
				)
				.toArray()
		])
		await this.gate.assertReadUnchanged(stamp)
		const used = new Map(counts.map(row => [String(row._id), row.count]))
		return {
			revision: stamp.revision,
			colors: colors.map(row => ({
				_id: String(row._id),
				name_en: row.name_en as string,
				name_uk: row.name_uk as string,
				slug: row.slug as string,
				family: row.family as string,
				hex_stops: row.hex_stops as string[],
				order: (row.order ?? 0) as number,
				variant_count: used.get(String(row._id)) ?? 0
			}))
		}
	}

	async create(request: WriteRequest, input: unknown) {
		const entry = normalise(colorEntrySchema.parse(input))
		const id = createHash('sha256')
			.update(`color:${request.operationId}`)
			.digest('hex')
			.slice(0, 24)
		return this.run(request, { type: 'color-create', entry }, id, async () => {
			const slug = entry.slug ?? generateSlug(entry.name_en)
			await this.assertIdentityFree(entry.name_en, slug)
			const now = new Date()
			return [
				{
					collection: 'colors',
					id,
					fields: {},
					creation: {
						_id: new mongo.ObjectId(id),
						name_en: entry.name_en,
						name_uk: entry.name_uk,
						slug,
						family: entry.family,
						hex_stops: entry.hex_stops,
						order: entry.order ?? 0,
						createdAt: now,
						updatedAt: now
					}
				}
			]
		})
	}

	async update(request: WriteRequest, id: string, input: unknown) {
		const entry = normalise(colorEntrySchema.parse(input))
		return this.run(request, { type: 'color-update', id, entry }, id, async () => {
			const row = await this.color(id)
			const next = {
				name_en: entry.name_en,
				name_uk: entry.name_uk,
				slug: entry.slug ?? (row.slug as string),
				family: entry.family,
				hex_stops: entry.hex_stops,
				order: entry.order ?? ((row.order ?? 0) as number)
			}
			await this.assertIdentityFree(next.name_en, next.slug, id)
			const fields: CatalogPatch['fields'] = {}
			for (const [key, value] of Object.entries(next))
				if (!isDeepStrictEqual(row[key] ?? null, value))
					fields[key] = image(row, key, value)
			if (!Object.keys(fields).length) throw new ColorAdminError('COLOR_UNCHANGED')
			fields.updatedAt = image(row, 'updatedAt', new Date())
			const patches: CatalogPatch[] = [{ collection: 'colors', id, fields }]
			// What the SKUs of this colour denormalize: only the drifted ones, as the legacy
			// backfill (a move of `order` or a hex stop writes no SKU at all).
			const label = formatColorLabel(next.name_uk, next.name_en)
			const variants = await this.db
				.collection('product_variants')
				.aggregate(
					[
						{ $match: { color_id: new mongo.ObjectId(id) } },
						{
							$lookup: {
								from: 'products',
								localField: 'product_id',
								foreignField: '_id',
								as: 'product',
								pipeline: [{ $project: { name: 1 } }]
							}
						},
						{
							$project: {
								name: 1,
								v_value: 1,
								color_family: 1,
								product_name: { $first: '$product.name' }
							}
						}
					],
					{ readPreference: 'primary' }
				)
				.toArray()
			for (const variant of variants) {
				const changed: CatalogPatch['fields'] = {}
				if (variant.color_family !== next.family)
					changed.color_family = image(variant, 'color_family', next.family)
				if (typeof variant.product_name === 'string') {
					const name = variantName(
						variant.product_name,
						variant.v_value as string | null,
						label
					)
					if (name !== variant.name) changed.name = image(variant, 'name', name)
				}
				if (Object.keys(changed).length)
					patches.push({
						collection: 'product_variants',
						id: String(variant._id),
						fields: changed
					})
			}
			if (patches.length > PLAN_MAX_TARGETS)
				throw new ColorAdminError('COLOR_PLAN_TOO_LARGE', patches.length - 1)
			return patches
		})
	}

	async remove(request: WriteRequest, id: string) {
		return this.run(request, { type: 'color-delete', id }, id, async () => {
			const row = await this.color(id)
			const count = await this.db
				.collection('product_variants')
				.countDocuments(
					{ color_id: { $in: [new mongo.ObjectId(id), id] } },
					{ readPreference: 'primary' }
				)
			if (count) throw new ColorAdminError('COLOR_IN_USE', count)
			return [{ collection: 'colors', id, fields: {}, deletion: row }]
		})
	}

	private async color(id: string) {
		const row = await this.db
			.collection('colors')
			.findOne({ _id: new mongo.ObjectId(id) }, { readPreference: 'primary' })
		if (!row) throw new ColorAdminError('COLOR_NOT_FOUND')
		return row
	}
	private async assertIdentityFree(nameEn: string, slug: string, except?: string) {
		const conflict = await this.db.collection('colors').findOne(
			{
				$or: [{ name_en: nameEn }, { slug }],
				...(except ? { _id: { $ne: new mongo.ObjectId(except) } } : {})
			},
			{ readPreference: 'primary', projection: { _id: 1 } }
		)
		if (conflict) throw new ColorAdminError('COLOR_IDENTITY_CONFLICT')
	}

	private async run(
		request: WriteRequest,
		command: object,
		id: string,
		plan: () => Promise<CatalogPatch[]>
	) {
		const hash = createHash('sha256')
			.update(mongo.BSON.serialize({ expected_revision: request.expectedRevision, command }))
			.digest('hex')
		const enabled = () =>
			this.db
				.collection<{ _id: string }>('catalog_control')
				.findOne({ _id: 'catalog', admin_draft_writes_enabled: true })
		if (!(await enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
		const receipt = (revision: number) => ({
			operation_id: request.operationId,
			revision,
			color_id: id
		})
		const previous = await this.gate.operation(request.operationId)
		if (previous) {
			if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			if (previous.status === 'completed' && previous.revision !== undefined)
				return receipt(previous.revision)
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}
		const token = await this.gate.acquire(
			request.operationId,
			hash,
			request.ownerId,
			request.expectedRevision
		)
		let started = false
		try {
			if (!(await enabled())) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
			await this.journal.prepare(token, await plan())
			started = true
			await this.journal.execute(token, 'apply')
			await this.gate.publishVerified(token)
			return receipt(token.revision + 1)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}
}
interface WriteRequest {
	operationId: string
	ownerId: string
	expectedRevision: number
}
const image = (row: mongo.Document, key: string, value: unknown) => ({
	before: Object.hasOwn(row, key)
		? { exists: true as const, value: row[key] as unknown }
		: { exists: false as const },
	after: { exists: true as const, value }
})
/** Hex is case-insensitive; one casing, as `ColorService` stores it. */
const normalise = (entry: ColorEntry): ColorEntry => ({
	...entry,
	hex_stops: entry.hex_stops.map(stop => stop.toLowerCase())
})

export class ColorEntryDto {
	@ApiProperty({ maxLength: 100 }) name_en!: string
	@ApiProperty({ maxLength: 100 }) name_uk!: string
	@ApiProperty({ required: false, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }) slug?: string
	@ApiProperty({ enum: ColorFamily }) family!: ColorFamily
	@ApiProperty({ type: [String], minItems: 1, maxItems: 6, example: ['#000000'] })
	hex_stops!: string[]
	@ApiProperty({ required: false, minimum: 0 }) order?: number
}
export class ColorEntryWriteDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
	@ApiProperty({ type: ColorEntryDto }) color!: ColorEntryDto
}
export class ColorRevisionDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
}
export class ColorAdminEntryDto extends ColorEntryDto {
	@ApiProperty() _id!: string
	@ApiProperty() declare slug: string
	@ApiProperty() declare order: number
	@ApiProperty({ description: 'SKUs (any status) pointing at this colour' })
	variant_count!: number
}
export class ColorAdminListDto {
	@ApiProperty() revision!: number
	@ApiProperty({ type: [ColorAdminEntryDto] }) colors!: ColorAdminEntryDto[]
}
export class ColorReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() color_id!: string
}

@Injectable()
export class ColorAdminService {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	private writer() {
		return new ColorAdminWriter(this.connection.db!)
	}
	async read() {
		try {
			return await this.writer().read()
		} catch (error) {
			this.fail(error)
		}
	}
	async write(
		action: 'create' | 'update' | 'remove',
		key: string | undefined,
		body: unknown,
		id?: string
	) {
		if (id !== undefined && !/^[a-f0-9]{24}$/i.test(id))
			throw new NotFoundException({ details: { code: 'COLOR_NOT_FOUND' } })
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const parsed = z
				.strictObject({
					expected_revision: z.number().int().nonnegative().safe(),
					color: z.unknown().optional()
				})
				.parse(body)
			const request = {
				operationId: uuid.data.toLowerCase(),
				ownerId: randomUUID(),
				expectedRevision: parsed.expected_revision
			}
			const writer = this.writer()
			const receipt =
				action === 'create'
					? await writer.create(request, parsed.color)
					: action === 'update'
						? await writer.update(request, id!.toLowerCase(), parsed.color)
						: await writer.remove(request, id!.toLowerCase())
			// Colour names and families are on every card, the cart, the filters and the feed.
			storefrontRevalidation.revalidate('products', 'colour dictionary')
			storefrontRevalidation.revalidate('categories', 'colour dictionary')
			feedRefresh.request('colour dictionary')
			return receipt
		} catch (error) {
			this.fail(error, uuid.data.toLowerCase())
		}
	}
	private fail(error: unknown, operation_id?: string): never {
		const code =
			error instanceof CatalogGateError ||
			error instanceof ColorAdminError ||
			error instanceof CatalogJournalError
				? error.code
				: error instanceof z.ZodError
					? 'INVALID_COLOR'
					: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
		const body = {
			message: 'Не вдалося змінити словник кольорів',
			details: {
				code,
				operation_id,
				...(error instanceof ColorAdminError && error.count !== undefined
					? { count: error.count }
					: {})
			}
		}
		if (code === 'INVALID_COLOR') throw new BadRequestException(body)
		if (code === 'COLOR_NOT_FOUND') throw new NotFoundException(body)
		if (
			[
				'COLOR_UNCHANGED',
				'COLOR_IN_USE',
				'COLOR_IDENTITY_CONFLICT',
				'COLOR_PLAN_TOO_LARGE',
				'CATEGORY_REVISION_CONFLICT',
				'IDEMPOTENCY_KEY_REUSED',
				'OPERATION_ALREADY_REGISTERED'
			].includes(code)
		)
			throw new ConflictException(body)
		throw new ServiceUnavailableException(body)
	}
}

const idempotency = {
	name: 'Idempotency-Key',
	required: true,
	schema: { type: 'string' as const, format: 'uuid' }
}

@Controller(ENDPOINTS.COLORS.BASE)
@ApiTags(ENDPOINTS.COLORS.BASE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ColorAdminController {
	constructor(private readonly service: ColorAdminService) {}
	@Get(ENDPOINTS.COLORS.ADMIN_ENTRIES)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.COLORS.ADMIN_ENTRIES)
	@ApiOkResponse({ type: ColorAdminListDto })
	@ApiResponse({ status: 503, description: 'Catalog busy or changed during the read' })
	read() {
		return this.service.read()
	}
	@Post(ENDPOINTS.COLORS.ADMIN_ENTRIES)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.COLORS.ADMIN_CREATE)
	@ApiBody({ type: ColorEntryWriteDto })
	@ApiHeader(idempotency)
	@ApiResponse({ status: 201, type: ColorReceiptDto })
	@ApiResponse({ status: 400, description: 'INVALID_COLOR or invalid Idempotency-Key' })
	@ApiResponse({ status: 409, description: 'Name or slug taken, revision conflict' })
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	create(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
		return this.service.write('create', key, body)
	}
	@Patch(ENDPOINTS.COLORS.ADMIN_ENTRY)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.COLORS.ADMIN_UPDATE)
	@ApiBody({ type: ColorEntryWriteDto })
	@ApiHeader(idempotency)
	@ApiOkResponse({ type: ColorReceiptDto })
	@ApiResponse({ status: 400, description: 'INVALID_COLOR or invalid Idempotency-Key' })
	@ApiResponse({ status: 404, description: 'COLOR_NOT_FOUND' })
	@ApiResponse({
		status: 409,
		description:
			'COLOR_UNCHANGED, COLOR_IDENTITY_CONFLICT, COLOR_PLAN_TOO_LARGE (more than 499 SKUs to rewrite), revision conflict'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	update(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.write('update', key, body, id)
	}
	@Post(ENDPOINTS.COLORS.ADMIN_DELETION)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.COLORS.ADMIN_DELETE)
	@ApiBody({ type: ColorRevisionDto })
	@ApiHeader(idempotency)
	@ApiOkResponse({ type: ColorReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid body or Idempotency-Key' })
	@ApiResponse({ status: 404, description: 'COLOR_NOT_FOUND' })
	@ApiResponse({ status: 409, description: 'COLOR_IN_USE (details.count SKUs), revision' })
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	remove(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.write('remove', key, body, id)
	}
}
