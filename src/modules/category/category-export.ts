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
	Param,
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
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CatalogMutationJournal,
	type CatalogPatch
} from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { runCatalogOperation } from 'src/database/mongoose/repositories/catalog-operation'

/**
 * The Google taxonomy node of a v2 product category (Plan-0010 B10) — the one feed setting a
 * category has. Title, highlights and custom labels follow the feed's own rules for every
 * category: the per-category title/highlight keys and static labels were removed (owner,
 * 04.11.2026) as interface complexity without a use. Journal profile `export`.
 */
export const categoryExportSchema = z.strictObject({
	google_product_category: z
		.strictObject({ id: z.number().int().positive(), path: z.string().trim().min(1).max(500) })
		.nullable()
})
export type CategoryExport = z.infer<typeof categoryExportSchema>

export class CategoryExportError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'CategoryExportError'
	}
}

export class CategoryExportWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'export')
	}
	private async category(id: string) {
		const row = await this.db
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id) }, { readPreference: 'primary' })
		if (!row) throw new CategoryExportError('CATEGORY_NOT_FOUND')
		if (
			row.attribute_contract_version !== 2 ||
			row.kind !== 'product' ||
			!['draft', 'active'].includes(row.status as string)
		)
			throw new CategoryExportError('CATEGORY_EXPORT_UNAVAILABLE')
		return row
	}
	async read(id: string) {
		const stamp = await this.gate.readStamp()
		const row = await this.category(id)
		await this.gate.assertReadUnchanged(stamp)
		return {
			category_id: id,
			revision: stamp.revision,
			name: row.name as string,
			slug: row.slug as string,
			kind: row.kind as string,
			status: row.status as string,
			google_product_category: (row.google_product_category ??
				null) as CategoryExport['google_product_category']
		}
	}
	async write(
		request: { operationId: string; ownerId: string; expectedRevision: number },
		id: string,
		input: unknown
	) {
		const value = categoryExportSchema.parse(input)
		const { db, gate, journal } = this
		return runCatalogOperation(
			{ db, gate, journal },
			{
				request,
				hashed: {
					type: 'category-export',
					id,
					expected_revision: request.expectedRevision,
					value
				},
				receipt: { category_id: id },
				build: async (): Promise<CatalogPatch[]> => {
					const row = await this.category(id)
					const taxonomy = value.google_product_category && {
						id: value.google_product_category.id,
						// Google's own path text («Hardware > Power»): admin-only, never rendered as HTML.
						// eslint-disable-next-line no-control-regex -- stripping C0 control characters is the intent
						path: value.google_product_category.path.replace(/[\u0000-\u001f]/g, '')
					}
					if (isDeepStrictEqual(row.google_product_category ?? null, taxonomy))
						throw new CategoryExportError('EXPORT_UNCHANGED')
					const image = (key: string) =>
						Object.hasOwn(row, key)
							? { exists: true as const, value: row[key] as unknown }
							: { exists: false as const }
					return [
						{
							collection: 'categories',
							id,
							fields: {
								google_product_category: {
									before: image('google_product_category'),
									after: { exists: true, value: taxonomy }
								},
								updatedAt: {
									before: Object.hasOwn(row, 'updatedAt')
										? { exists: true, value: row.updatedAt as unknown }
										: { exists: false },
									after: { exists: true, value: new Date() }
								}
							}
						}
					]
				}
			}
		)
	}
}

class GoogleCategoryDto {
	@ApiProperty({ minimum: 1 }) id!: number
	@ApiProperty({ maxLength: 500 }) path!: string
}
export class CategoryExportWriteDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
	@ApiProperty({ type: GoogleCategoryDto, nullable: true })
	google_product_category!: GoogleCategoryDto | null
}
export class CategoryExportReadDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() name!: string
	@ApiProperty() slug!: string
	@ApiProperty({ enum: ['product'] }) kind!: string
	@ApiProperty({ enum: ['draft', 'active'] }) status!: string
	@ApiProperty({ type: GoogleCategoryDto, nullable: true })
	google_product_category!: GoogleCategoryDto | null
}
export class CategoryExportReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() category_id!: string
}

@Injectable()
export class CategoryExportService {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	private id(id: string) {
		if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Invalid category ID')
		return id.toLowerCase()
	}
	async read(id: string) {
		try {
			return await new CategoryExportWriter(this.connection.db!).read(this.id(id))
		} catch (error) {
			this.fail(error)
		}
	}
	async write(id: string, key: string | undefined, body: unknown) {
		const categoryId = this.id(id)
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const parsed = z
				.strictObject({
					expected_revision: z.number().int().nonnegative().safe(),
					google_product_category: z.unknown()
				})
				.parse(body)
			const receipt = await new CategoryExportWriter(this.connection.db!).write(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: parsed.expected_revision
				},
				categoryId,
				{ google_product_category: parsed.google_product_category }
			)
			// The feed is the only reader: rebuild it before the hour.
			feedRefresh.request('category Google taxonomy')
			return receipt
		} catch (error) {
			this.fail(error, uuid.data.toLowerCase())
		}
	}
	private fail(error: unknown, operation_id?: string): never {
		const code =
			error instanceof CatalogGateError || error instanceof CategoryExportError
				? error.code
				: error instanceof z.ZodError
					? 'INVALID_EXPORT_FIELDS'
					: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
		const body = {
			message: 'Не вдалося зберегти категорію Google',
			details: { code, operation_id }
		}
		if (code === 'INVALID_EXPORT_FIELDS') throw new BadRequestException(body)
		if (code === 'CATEGORY_NOT_FOUND') throw new NotFoundException(body)
		if (
			[
				'CATEGORY_EXPORT_UNAVAILABLE',
				'EXPORT_UNCHANGED',
				'CATEGORY_REVISION_CONFLICT',
				'IDEMPOTENCY_KEY_REUSED',
				'OPERATION_ALREADY_REGISTERED'
			].includes(code)
		)
			throw new ConflictException(body)
		throw new ServiceUnavailableException(body)
	}
}

@Controller(ENDPOINTS.CATEGORIES.BASE)
@ApiTags(ENDPOINTS.CATEGORIES.BASE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CategoryExportController {
	constructor(private readonly service: CategoryExportService) {}
	@Get(ENDPOINTS.CATEGORIES.ADMIN_EXPORT)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_EXPORT_READ)
	@ApiOkResponse({ type: CategoryExportReadDto })
	@ApiResponse({ status: 409, description: 'Not a draft/published v2 product category' })
	read(@Param('id') id: string) {
		return this.service.read(id)
	}
	@Patch(ENDPOINTS.CATEGORIES.ADMIN_EXPORT)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_EXPORT_WRITE)
	@ApiBody({ type: CategoryExportWriteDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: CategoryExportReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid fields' })
	@ApiResponse({
		status: 409,
		description: 'Unchanged, revision conflict or unavailable category'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	write(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.write(id, key, body)
	}
}
