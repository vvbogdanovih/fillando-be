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
import { sanitizePlainText, sanitizeRichText } from 'src/common/utils/html.utils'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
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
 * Managed SEO copy of a v2 category (Plan-0010 B09/F05): the title, description, H1 and the text
 * above/below the listing the storefront already reads from `category.seo`. A content edit, so it
 * is allowed on published categories too; it goes through the gate and journal (profile `seo`, the
 * `seo` object only) so it shares the catalogue revision.
 */
const text = (max: number) =>
	z
		.string()
		.max(max)
		.nullable()
		.transform(value => (value?.trim() ? value.trim() : null))
export const categorySeoSchema = z.strictObject({
	title: text(300),
	description: text(1000),
	h1: text(300),
	intro_html: text(100000),
	bottom_html: text(200000)
})
export type CategorySeo = z.infer<typeof categorySeoSchema>
const EMPTY: CategorySeo = {
	title: null,
	description: null,
	h1: null,
	intro_html: null,
	bottom_html: null
}
/** Stored copy, normalised: plain text stays text, rich text is sanitized, empty is null. */
export function cleanSeo(input: CategorySeo): CategorySeo {
	const rich = (value: string | null) => {
		const html = value === null ? null : sanitizeRichText(value)
		// Quill leaves `<p><br></p>` behind a cleared editor: that is no copy at all.
		return html && html.replace(/<[^>]*>/g, '').trim() ? html : null
	}
	return {
		title: input.title === null ? null : sanitizePlainText(input.title),
		description: input.description === null ? null : sanitizePlainText(input.description),
		h1: input.h1 === null ? null : sanitizePlainText(input.h1),
		intro_html: rich(input.intro_html),
		bottom_html: rich(input.bottom_html)
	}
}
const stored = (value: unknown): CategorySeo => ({
	...EMPTY,
	...(value && typeof value === 'object' ? (value as Partial<CategorySeo>) : {})
})

export class CategorySeoError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'CategorySeoError'
	}
}

export class CategorySeoWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'seo')
	}
	private async category(id: string) {
		const row = await this.db
			.collection('categories')
			.findOne({ _id: new mongo.ObjectId(id) }, { readPreference: 'primary' })
		if (!row) throw new CategorySeoError('CATEGORY_NOT_FOUND')
		if (
			row.attribute_contract_version !== 2 ||
			!['draft', 'active'].includes(row.status as string)
		)
			throw new CategorySeoError('CATEGORY_SEO_UNAVAILABLE')
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
			seo: stored(row.seo)
		}
	}
	async write(
		request: { operationId: string; ownerId: string; expectedRevision: number },
		id: string,
		input: unknown
	) {
		const seo = cleanSeo(categorySeoSchema.parse(input))
		const { db, gate, journal } = this
		return runCatalogOperation(
			{ db, gate, journal },
			{
				request,
				hashed: {
					type: 'category-seo',
					id,
					expected_revision: request.expectedRevision,
					seo
				},
				receipt: { category_id: id },
				build: async (): Promise<CatalogPatch[]> => {
					const row = await this.category(id)
					if (isDeepStrictEqual(stored(row.seo), seo))
						throw new CategorySeoError('SEO_UNCHANGED')
					return [
						{
							collection: 'categories',
							id,
							fields: {
								seo: {
									before: Object.hasOwn(row, 'seo')
										? { exists: true, value: row.seo as unknown }
										: { exists: false },
									after: { exists: true, value: seo }
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

/** The SEO fields an admin writes and reads (limits included); the public detail has its own. */
export class CategorySeoFieldsDto {
	@ApiProperty({ type: String, nullable: true, maxLength: 300 }) title!: string | null
	@ApiProperty({ type: String, nullable: true, maxLength: 1000 }) description!: string | null
	@ApiProperty({ type: String, nullable: true, maxLength: 300 }) h1!: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'Sanitized rich text above the listing'
	})
	intro_html!: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		description: 'Sanitized rich text below the listing'
	})
	bottom_html!: string | null
}
export class CategorySeoWriteDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
	@ApiProperty({ type: CategorySeoFieldsDto }) seo!: CategorySeoFieldsDto
}
export class CategorySeoReadDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() name!: string
	@ApiProperty() slug!: string
	@ApiProperty({ enum: ['group', 'product'] }) kind!: string
	@ApiProperty({ enum: ['draft', 'active'] }) status!: string
	@ApiProperty({ type: CategorySeoFieldsDto }) seo!: CategorySeoFieldsDto
}
export class CategorySeoReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() category_id!: string
}

@Injectable()
export class CategorySeoService {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	private id(id: string) {
		if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Invalid category ID')
		return id.toLowerCase()
	}
	async read(id: string) {
		try {
			return await new CategorySeoWriter(this.connection.db!).read(this.id(id))
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
					seo: z.unknown()
				})
				.parse(body)
			const receipt = await new CategorySeoWriter(this.connection.db!).write(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: parsed.expected_revision
				},
				categoryId,
				parsed.seo
			)
			storefrontRevalidation.revalidate('categories', 'category seo')
			return receipt
		} catch (error) {
			this.fail(error, uuid.data.toLowerCase())
		}
	}
	private fail(error: unknown, operation_id?: string): never {
		const code =
			error instanceof CatalogGateError || error instanceof CategorySeoError
				? error.code
				: error instanceof z.ZodError
					? 'INVALID_SEO_FIELDS'
					: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
		const body = {
			message: 'Не вдалося зберегти SEO категорії',
			details: { code, operation_id }
		}
		if (code === 'INVALID_SEO_FIELDS') throw new BadRequestException(body)
		if (code === 'CATEGORY_NOT_FOUND') throw new NotFoundException(body)
		if (
			[
				'CATEGORY_SEO_UNAVAILABLE',
				'SEO_UNCHANGED',
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
export class CategorySeoController {
	constructor(private readonly service: CategorySeoService) {}
	@Get(ENDPOINTS.CATEGORIES.ADMIN_SEO)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_SEO_READ)
	@ApiOkResponse({ type: CategorySeoReadDto })
	@ApiResponse({ status: 409, description: 'Not a draft/published v2 category' })
	read(@Param('id') id: string) {
		return this.service.read(id)
	}
	@Patch(ENDPOINTS.CATEGORIES.ADMIN_SEO)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_SEO_WRITE)
	@ApiBody({ type: CategorySeoWriteDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: CategorySeoReceiptDto })
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
