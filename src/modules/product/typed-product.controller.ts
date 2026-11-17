import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Allow } from 'class-validator'
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
	Post,
	HttpCode,
	Query,
	ServiceUnavailableException,
	UseGuards
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection } from 'mongoose'
import {
	ApiBody,
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiPropertyOptional,
	ApiQuery,
	ApiResponse,
	ApiTags,
	OmitType
} from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { CatalogGateError } from 'src/database/mongoose/repositories/catalog-write-gate'
import { AttributeContractError } from '../category/attribute-definitions'
import { AttributeDefinitionDto } from '../category/dto/category-definitions.dto'
import { TypedProductWriter } from './typed-product-writer'
import {
	typedProductEditSchema,
	typedProductCreateSchema,
	TypedProductCreate,
	TypedProductEdit,
	TypedProductError,
	ProductNotReadyError
} from './typed-product'
import { TypedProductCreator } from './typed-product-creator'
import { TypedProductTransferWriter } from './typed-product-transfer'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import { PromoValidationError } from './promo-pricing'

const scalarDoc = {
	oneOf: [{ type: 'string' as const }, { type: 'number' as const }, { type: 'boolean' as const }]
}
export class ProductDetailsVariantDto {
	@ApiProperty() id!: string
	@ApiProperty({ minimum: 0, maximum: 1000000000 }) price!: number
	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, type: 'integer' }) stock!: number
	@ApiProperty({ nullable: true, minimum: 1, maximum: 1000000000, type: 'integer' }) weight_g!:
		| number
		| null
	@ApiProperty({
		type: String,
		nullable: true,
		required: false,
		maxLength: 100,
		description: 'Supplier article (admin-only). Omit to keep; empty/null clears.'
	})
	vendor_product_sku?: string | null
	@ApiProperty({
		type: String,
		nullable: true,
		required: false,
		maxLength: 100,
		description:
			'Prom product id — key of the Prom price/stock sync (admin-only). Omit to keep.'
	})
	prom_id?: string | null
	@ApiProperty({
		type: 'integer',
		nullable: true,
		required: false,
		minimum: 1,
		maximum: 90,
		description: 'Promotion percent (TD-0012). Omit to keep; null clears percent and end date.'
	})
	promo_percent?: number | null
	@ApiProperty({
		type: String,
		format: 'date-time',
		nullable: true,
		required: false,
		description: 'Promotion end (future ISO date-time). Omit to keep; null removes the end.'
	})
	promo_ends_at?: string | null
	@ApiProperty({ type: [String], maxItems: 30 }) images!: string[]
}
export class ProductDetailsDto {
	@ApiProperty({ pattern: '^[a-f0-9]{64}$' }) token!: string
	@ApiProperty({
		type: 'object',
		nullable: true,
		required: ['html', 'json'],
		additionalProperties: false,
		properties: {
			html: { type: 'string', maxLength: 100000 },
			json: { type: 'object', additionalProperties: true }
		}
	})
	description!: { html: string; json: Record<string, unknown> } | null
	@ApiProperty({ type: [ProductDetailsVariantDto], minItems: 1, maxItems: 100 })
	variants!: ProductDetailsVariantDto[]
}
export class TypedProductEditDto {
	@ApiProperty({
		required: false,
		oneOf: [
			{
				type: 'object',
				additionalProperties: false,
				required: ['type', 'variant_value', 'price', 'stock', 'weight_g'],
				properties: {
					type: { type: 'string', enum: ['add'] },
					variant_value: scalarDoc,
					price: { type: 'number', minimum: 0, maximum: 1000000000 },
					stock: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
					weight_g: { type: 'integer', nullable: true, minimum: 1, maximum: 1000000000 },
					vendor_product_sku: { type: 'string', nullable: true, maxLength: 100 },
					prom_id: { type: 'string', nullable: true, maxLength: 100 },
					images: {
						type: 'array',
						maxItems: 30,
						items: { type: 'string', format: 'uri', maxLength: 2048 },
						description:
							'Photos of the new SKU: public http(s) URLs in display order, uploaded beforehand. Default: none'
					},
					status: {
						type: 'string',
						enum: ['draft', 'active'],
						description:
							'Default: draft. Active only in a published category and only for a complete product (409 PRODUCT_NOT_READY with the readiness issues)'
					}
				}
			},
			{
				type: 'object',
				additionalProperties: false,
				required: ['type', 'id', 'status'],
				properties: {
					type: { type: 'string', enum: ['status'] },
					id: { type: 'string', pattern: '^[a-f0-9]{24}$' },
					status: { type: 'string', enum: ['draft', 'active', 'archived'] }
				}
			},
			{
				type: 'object',
				additionalProperties: false,
				required: ['type', 'id'],
				properties: {
					type: { type: 'string', enum: ['archive', 'restore', 'delete'] },
					id: { type: 'string', pattern: '^[a-f0-9]{24}$' }
				},
				description:
					'delete: a never-sold draft/archived SKU (the product keeps at least one)'
			},
			{
				type: 'object',
				additionalProperties: false,
				required: ['type'],
				properties: { type: { type: 'string', enum: ['archive_all'] } },
				description: 'Every draft/active SKU of the product → archived, in one plan'
			}
		]
	})
	@Allow()
	variant_action?: TypedProductEdit['variant_action']

	@ApiProperty({ type: ProductDetailsDto, required: false }) @Allow() details?: ProductDetailsDto

	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	@Allow()
	expected_revision!: number
	@ApiProperty({ maxLength: 200 }) @Allow() name!: string
	@ApiProperty({
		required: false,
		pattern: '^[a-f0-9]{24}$',
		description: 'Supplier (vendor) of the product; omit to keep'
	})
	@Allow()
	vendor_id?: string
	@ApiProperty({
		type: 'array',
		maxItems: 1000,
		items: {
			type: 'object',
			required: ['k', 'v'],
			additionalProperties: false,
			properties: { k: { type: 'string' }, v: scalarDoc }
		}
	})
	@Allow()
	attributes_v2!: TypedProductEdit['attributes_v2']
	@ApiProperty({
		type: 'object',
		nullable: true,
		required: ['key'],
		additionalProperties: false,
		properties: { key: { type: 'string' } }
	})
	@Allow()
	variant_axis!: TypedProductEdit['variant_axis']
	@ApiProperty({
		type: 'array',
		minItems: 1,
		maxItems: 100,
		items: {
			type: 'object',
			required: ['id', 'variant_value'],
			additionalProperties: false,
			properties: {
				id: { type: 'string', pattern: '^[a-f0-9]{24}$' },
				variant_value: { ...scalarDoc, nullable: true }
			}
		}
	})
	@Allow()
	variants!: TypedProductEdit['variants']
}
export class TypedProductCreateDto extends OmitType(TypedProductEditDto, [
	'variants',
	'details'
] as const) {
	@ApiProperty({ pattern: '^[a-f0-9]{24}$' }) @Allow() category_id!: string
	@ApiProperty({ pattern: '^[a-f0-9]{24}$' }) @Allow() vendor_id!: string
	@ApiPropertyOptional({
		type: 'object',
		nullable: true,
		additionalProperties: false,
		properties: {
			html: { type: 'string', maxLength: 100000 },
			json: { type: 'object', additionalProperties: true }
		},
		description: 'Description, sanitised and stored as a details save stores it. Default: none'
	})
	@Allow()
	description?: { html: string; json: Record<string, unknown> } | null
	@ApiPropertyOptional({
		type: 'object',
		nullable: true,
		additionalProperties: false,
		properties: {
			title: { type: 'string', maxLength: 120 },
			text: { type: 'string', maxLength: 1000 },
			badge: { type: 'string', nullable: true, maxLength: 40 }
		},
		description: 'The product’s own notice above the buy button (plain text). Default: none'
	})
	@Allow()
	purchase_notice?: TypedProductCreate['purchase_notice']
	@ApiProperty({
		type: 'array',
		minItems: 1,
		maxItems: 100,
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['variant_value', 'price', 'stock'],
			properties: {
				variant_value: { ...scalarDoc, nullable: true },
				price: { type: 'number', minimum: 0, maximum: 1000000000 },
				stock: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
				weight_g: {
					type: 'integer',
					nullable: true,
					minimum: 1,
					maximum: 1000000000,
					description: 'Parcel weight in grams. Default: unknown'
				},
				status: {
					type: 'string',
					enum: ['draft', 'active'],
					description:
						'Default: draft. Active only in a published category and only for a complete product (409 PRODUCT_NOT_READY with the readiness issues)'
				},
				vendor_product_sku: {
					type: 'string',
					nullable: true,
					maxLength: 100,
					description: 'Supplier article; default: the generated SKU'
				},
				prom_id: { type: 'string', nullable: true, maxLength: 100 },
				images: {
					type: 'array',
					maxItems: 30,
					items: { type: 'string', format: 'uri', maxLength: 2048 },
					description:
						'Photos of the SKU: public http(s) URLs in display order, uploaded beforehand (presign → PUT → confirm). Default: none'
				}
			}
		}
	})
	@Allow()
	variants!: TypedProductCreate['variants']
}
export class TypedDraftVariantDto {
	@ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: 'draft' | 'active' | 'archived'

	@ApiProperty() id!: string
	@ApiProperty({ ...scalarDoc, nullable: true }) variant_value!: string | number | boolean | null
	@ApiProperty() name!: string
	@ApiProperty() slug!: string
	@ApiProperty() sku!: string
	@ApiProperty({
		type: Number,
		nullable: true,
		description:
			'What the shop pays (from the Prom price); the editor warns about a promotion below it'
	})
	supplier_price!: number | null
}
export class ReadinessIssueDto {
	@ApiProperty() code!: string
	@ApiProperty() field!: string
	@ApiProperty({ required: false }) variant_id?: string
}
export class ProductReadinessDto {
	@ApiProperty() data_ready!: boolean
	@ApiProperty({ type: [ReadinessIssueDto] }) issues!: ReadinessIssueDto[]
	@ApiProperty({ type: [ReadinessIssueDto] }) warnings!: ReadinessIssueDto[]
}
export class TypedProductReadDto {
	@ApiProperty({ type: ProductReadinessDto }) readiness!: ProductReadinessDto

	@ApiProperty({ type: ProductDetailsDto }) details!: ProductDetailsDto

	@ApiProperty() product_id!: string
	@ApiProperty() category_id!: string
	@ApiProperty({ type: String, nullable: true }) vendor_id!: string | null
	@ApiProperty({ description: 'The category is published: edits reach the storefront at once' })
	published!: boolean
	@ApiProperty({ description: 'The variant axis holds dictionary colour ids' })
	color_axis!: boolean
	@ApiProperty() revision!: number
	@ApiProperty() name!: string
	@ApiProperty({ type: [AttributeDefinitionDto] }) definitions!: AttributeDefinitionDto[]
	@ApiProperty({
		type: 'array',
		items: {
			type: 'object',
			required: ['k', 'v'],
			properties: { k: { type: 'string' }, v: scalarDoc }
		}
	})
	attributes_v2!: TypedProductEdit['attributes_v2']
	@ApiProperty({
		type: 'object',
		nullable: true,
		required: ['key'],
		properties: { key: { type: 'string' } }
	})
	variant_axis!: TypedProductEdit['variant_axis']
	@ApiProperty({ type: [TypedDraftVariantDto] }) variants!: TypedDraftVariantDto[]
}
export class TypedProductTransferDto {
	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	@Allow()
	expected_revision!: number
	@ApiProperty({ pattern: '^[a-f0-9]{24}$' }) @Allow() target_category_id!: string
	@ApiProperty({
		type: 'array',
		maxItems: 200,
		description: 'Characteristics in the target category terms (the preview proposal, edited).',
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['k', 'v'],
			properties: { k: { type: 'string' }, v: scalarDoc }
		}
	})
	@Allow()
	attributes_v2!: { k: string; v: string | number | boolean }[]
	@ApiProperty({
		type: 'object',
		nullable: true,
		additionalProperties: false,
		required: ['key'],
		properties: { key: { type: 'string' } }
	})
	@Allow()
	variant_axis!: { key: string } | null
	@ApiProperty({
		type: 'array',
		minItems: 1,
		maxItems: 100,
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['id', 'variant_value'],
			properties: {
				id: { type: 'string', pattern: '^[a-f0-9]{24}$' },
				variant_value: { ...scalarDoc, nullable: true }
			}
		}
	})
	@Allow()
	variants!: { id: string; variant_value: string | number | boolean | null }[]
	@ApiProperty({
		type: [String],
		maxItems: 200,
		description: 'Source characteristic keys the admin agreed to lose (the preview `dropped`).'
	})
	@Allow()
	confirm_dropped!: string[]
}
export class TransferMappedDto {
	@ApiProperty() source_key!: string
	@ApiProperty() target_key!: string
	@ApiProperty() target_label!: string
	@ApiProperty(scalarDoc) value!: string | number | boolean
}
export class TransferDroppedDto {
	@ApiProperty() key!: string
	@ApiProperty() label!: string
	@ApiProperty(scalarDoc) value!: string | number | boolean
	@ApiProperty({ description: 'The value as the admin reads it (enum label, Так/Ні, unit)' })
	value_label!: string
	@ApiProperty({ enum: ['no_target', 'type', 'multiple', 'axis'] }) reason!: string
}
export class TransferCategoryDto {
	@ApiProperty() id!: string
	@ApiProperty() name!: string
	@ApiProperty({ enum: ['draft', 'active'] }) status!: string
}
export class TransferTargetDto extends TransferCategoryDto {
	@ApiProperty({ type: [AttributeDefinitionDto] }) definitions!: AttributeDefinitionDto[]
}
export class TypedProductTransferPreviewDto {
	@ApiProperty() revision!: number
	@ApiProperty() product_id!: string
	@ApiProperty() name!: string
	@ApiProperty({ type: TransferCategoryDto }) source!: TransferCategoryDto
	@ApiProperty({ type: TransferTargetDto }) target!: TransferTargetDto
	@ApiProperty({ type: [TransferMappedDto] }) mapped!: TransferMappedDto[]
	@ApiProperty({ type: [TransferDroppedDto] }) dropped!: TransferDroppedDto[]
	@ApiProperty({ type: [String], description: 'Required target keys without a value' })
	missing_required!: string[]
	@ApiProperty({
		nullable: true,
		enum: ['AXIS_NO_TARGET', 'AXIS_TYPE', 'AXIS_VALUES'],
		description: 'Why the variant axis does not fit the target; null when it does'
	})
	axis_problem!: string | null
	@ApiProperty({ description: 'Active SKUs that become drafts in a draft target' })
	variants_to_draft!: number
	@ApiProperty({
		type: 'object',
		description: 'Ready-to-send `attributes_v2` / `variant_axis` / `variants` for the transfer',
		additionalProperties: true
	})
	proposal!: Record<string, unknown>
}
export class TypedProductTransferReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() product_id!: string
	@ApiProperty() category_id!: string
}
export class TypedProductListItemDto {
	@ApiProperty() id!: string
	@ApiProperty() name!: string
}
export class TypedProductListDto {
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty({ type: [TypedProductListItemDto] }) items!: TypedProductListItemDto[]
	@ApiProperty({ description: 'Products of the category matching `q` (all of them without it)' })
	total!: number
	@ApiProperty({ type: String, nullable: true }) next_cursor!: string | null
}
export class TypedProductReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() product_id!: string
}
@Injectable()
export class TypedProductService {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	async create(key: string | undefined, body: unknown) {
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const { expected_revision, ...command } = typedProductCreateSchema
				.extend({ expected_revision: z.number().int().nonnegative().safe() })
				.parse(body)
			const receipt = await new TypedProductCreator(this.connection.db!).create(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: expected_revision
				},
				command
			)
			this.storefrontChanged('typed product create')
			return receipt
		} catch (error) {
			this.fail(error, false, uuid.data.toLowerCase())
		}
	}

	/**
	 * A published category's products are live: purge the storefront caches and let the feed
	 * rebuild early. Harmless for a draft (the throttled purge is cheap, drafts stay hidden).
	 */
	private storefrontChanged(trigger: string) {
		storefrontRevalidation.revalidate('products', trigger)
		feedRefresh.request(trigger)
	}

	async list(input: unknown) {
		const parsed = z
			.strictObject({
				category_id: z.string().regex(/^[a-f0-9]{24}$/),
				cursor: z.string().min(1).max(1000).optional(),
				page: z
					.string()
					.regex(/^[1-9]\d{0,5}$/)
					.transform(Number)
					.optional(),
				q: z.string().trim().min(1).max(100).optional()
			})
			.refine(query => !(query.cursor && query.page), 'cursor or page, not both')
			.safeParse(input)
		if (!parsed.success) throw new BadRequestException('Invalid product list query')
		try {
			return await new TypedProductWriter(this.connection.db!).list(
				parsed.data.category_id,
				parsed.data.cursor,
				{ page: parsed.data.page, q: parsed.data.q }
			)
		} catch (error) {
			this.fail(error, true)
		}
	}
	async read(id: string) {
		this.id(id)
		try {
			return await new TypedProductWriter(this.connection.db!).read(id.toLowerCase())
		} catch (error) {
			this.fail(error, true)
		}
	}
	async edit(id: string, key: string | undefined, body: unknown) {
		this.id(id)
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const parsed = typedProductEditSchema
				.extend({ expected_revision: z.number().int().nonnegative().safe() })
				.parse(body)
			const { expected_revision, ...command } = parsed
			const receipt = await new TypedProductWriter(this.connection.db!).edit(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: expected_revision
				},
				id.toLowerCase(),
				command
			)
			this.storefrontChanged('typed product edit')
			return receipt
		} catch (error) {
			this.fail(error, false, uuid.data.toLowerCase())
		}
	}
	async remove(id: string, key: string | undefined, body: unknown) {
		this.id(id)
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const { expected_revision } = z
				.strictObject({ expected_revision: z.number().int().nonnegative().safe() })
				.parse(body)
			const receipt = await new TypedProductWriter(this.connection.db!).remove(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: expected_revision
				},
				id.toLowerCase()
			)
			this.storefrontChanged('typed product delete')
			return receipt
		} catch (error) {
			this.fail(error, false, uuid.data.toLowerCase())
		}
	}
	async transferPreview(id: string, input: unknown) {
		this.id(id)
		const parsed = z
			.strictObject({ target_category_id: z.string().regex(/^[a-f0-9]{24}$/i) })
			.safeParse(input)
		if (!parsed.success) throw new BadRequestException('Invalid transfer target')
		try {
			return await new TypedProductTransferWriter(this.connection.db!).preview(
				id.toLowerCase(),
				parsed.data.target_category_id.toLowerCase()
			)
		} catch (error) {
			this.fail(error, true)
		}
	}
	async transfer(id: string, key: string | undefined, body: unknown) {
		this.id(id)
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			const { expected_revision, ...command } = z
				.looseObject({ expected_revision: z.number().int().nonnegative().safe() })
				.parse(body)
			const receipt = await new TypedProductTransferWriter(this.connection.db!).transfer(
				{
					operationId: uuid.data.toLowerCase(),
					ownerId: randomUUID(),
					expectedRevision: expected_revision
				},
				id.toLowerCase(),
				command
			)
			// Both listings and the navigation counts (a branch may become empty) change.
			storefrontRevalidation.revalidate('categories', 'typed product transfer')
			this.storefrontChanged('typed product transfer')
			return receipt
		} catch (error) {
			this.fail(error, false, uuid.data.toLowerCase())
		}
	}
	private id(id: string) {
		if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Invalid product ID')
	}
	private fail(error: unknown, read: boolean, operation_id?: string): never {
		if (error instanceof PromoValidationError)
			throw new BadRequestException({
				message: error.message,
				details: { code: error.code, operation_id }
			})
		const code =
			error instanceof CatalogGateError ||
			error instanceof TypedProductError ||
			error instanceof AttributeContractError
				? error.code
				: error instanceof z.ZodError
					? 'INVALID_PRODUCT_FIELDS'
					: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
		const body = {
			message: 'Не вдалося опрацювати чернетку товару',
			details: {
				code,
				operation_id,
				...(error instanceof AttributeContractError ? { field: error.field } : {}),
				// What a SKU asked to go active still lacks, in `productReadiness` terms.
				...(error instanceof ProductNotReadyError ? { issues: error.issues } : {})
			}
		}
		if (code === 'INVALID_PRODUCT_CURSOR') throw new BadRequestException(body)
		if (['PRODUCT_NOT_FOUND', 'CATEGORY_NOT_FOUND', 'VENDOR_NOT_FOUND'].includes(code))
			throw new NotFoundException(body)
		if (
			[
				'CATALOG_CONTRACT_UPGRADE_REQUIRED',
				'PRODUCT_EDIT_REQUIRES_DRAFT',
				'PRODUCT_VARIANT_LIMIT',
				'COLOR_ADAPTER_REQUIRED',
				'VARIANT_SET_CHANGED',
				'VARIANT_STATUS_CONFLICT',
				'SKU_COUNTER_UNAVAILABLE',
				'SKU_COUNTER_CONFLICT',
				'PRODUCT_IDENTITY_INDEX_MISSING',
				'PRODUCT_IDENTITY_CONFLICT',
				'PRODUCT_CURSOR_CHANGED',
				'PRODUCT_DETAILS_CHANGED',
				'CATEGORY_REVISION_CONFLICT',
				'IDEMPOTENCY_KEY_REUSED',
				'OPERATION_ALREADY_REGISTERED',
				'TRANSFER_TARGET_INVALID',
				'TRANSFER_SAME_CATEGORY',
				'TRANSFER_AXIS_INCOMPATIBLE',
				'TRANSFER_PLAN_CHANGED',
				'VARIANT_DELETE_REQUIRES_INACTIVE',
				'PRODUCT_DELETE_REQUIRES_INACTIVE',
				'PRODUCT_NEEDS_A_VARIANT',
				'VARIANT_IN_USE',
				'PRODUCT_IN_USE',
				'PRODUCT_NOT_READY'
			].includes(code)
		)
			throw new ConflictException(body)
		if (
			!read &&
			(error instanceof z.ZodError ||
				error instanceof AttributeContractError ||
				(error instanceof TypedProductError &&
					[
						'SINGLE_VARIANT_REQUIRED',
						'VARIANT_AXIS_REQUIRED',
						'DUPLICATE_VARIANT_ID',
						'UNEXPECTED_VARIANT_VALUE',
						'DUPLICATE_VARIANT_VALUE',
						'UNKNOWN_COLOR'
					].includes(code)))
		)
			throw new BadRequestException(body)
		throw new ServiceUnavailableException(body)
	}
}
@Controller(ENDPOINTS.PRODUCTS.BASE)
@ApiTags(ENDPOINTS.PRODUCTS.BASE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class TypedProductController {
	constructor(private readonly service: TypedProductService) {}
	@Post(ENDPOINTS.PRODUCTS.TYPED_DRAFT_LIST)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_DRAFT_CREATE)
	@ApiBody({ type: TypedProductCreateDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiResponse({ status: 201, type: TypedProductReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid typed fields, price, stock or axis' })
	@ApiResponse({ status: 404, description: 'Category or vendor missing' })
	@ApiResponse({
		status: 409,
		description:
			'Revision, draft, identity or counter conflict; PRODUCT_NOT_READY (with `details.issues`) for an active SKU of an incomplete product'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	create(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
		return this.service.create(key, body)
	}

	@Get(ENDPOINTS.PRODUCTS.TYPED_DRAFT_LIST)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_DRAFT_LIST)
	@ApiQuery({ name: 'category_id', required: true, type: String })
	@ApiQuery({ name: 'cursor', required: false, type: String })
	@ApiQuery({
		name: 'page',
		required: false,
		type: Number,
		description: '1-based; not with cursor'
	})
	@ApiQuery({ name: 'q', required: false, type: String, description: 'Name contains (1–100)' })
	@ApiOkResponse({ type: TypedProductListDto })
	@ApiResponse({ status: 400, description: 'Invalid category id, cursor, page or q' })
	@ApiResponse({ status: 404, description: 'CATEGORY_NOT_FOUND' })
	@ApiResponse({
		status: 409,
		description: 'PRODUCT_CURSOR_CHANGED — the category changed between pages; start again'
	})
	@ApiResponse({ status: 503, description: 'Catalog busy or changed' })
	list(@Query() query: Record<string, unknown>) {
		return this.service.list(query)
	}
	@Get(ENDPOINTS.PRODUCTS.TYPED_DRAFT)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_DRAFT_READ)
	@ApiOkResponse({ type: TypedProductReadDto })
	@ApiResponse({ status: 400, description: 'Invalid product id' })
	@ApiResponse({ status: 404, description: 'Product missing' })
	@ApiResponse({
		status: 409,
		description: 'Requires prepared v2 draft data; legacy or active products are not edited.'
	})
	@ApiResponse({ status: 503, description: 'Catalog busy, changed or typed data unavailable.' })
	read(@Param('id') id: string) {
		return this.service.read(id)
	}
	@Get(ENDPOINTS.PRODUCTS.TYPED_TRANSFER)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_TRANSFER_PREVIEW)
	@ApiQuery({ name: 'target_category_id', required: true, type: String })
	@ApiOkResponse({ type: TypedProductTransferPreviewDto })
	@ApiResponse({ status: 404, description: 'Product or category missing' })
	@ApiResponse({
		status: 409,
		description: 'Same category, or the source/target is not an editable v2 product category'
	})
	@ApiResponse({ status: 503, description: 'Catalog busy or changed' })
	transferPreview(@Param('id') id: string, @Query() query: Record<string, unknown>) {
		return this.service.transferPreview(id, query)
	}
	@Post(ENDPOINTS.PRODUCTS.TYPED_TRANSFER)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_TRANSFER)
	@ApiBody({ type: TypedProductTransferDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiResponse({ status: 201, type: TypedProductTransferReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid or missing required values for the target' })
	@ApiResponse({ status: 404, description: 'Product or category missing' })
	@ApiResponse({
		status: 409,
		description:
			'Revision conflict, incompatible axis, changed product (TRANSFER_PLAN_CHANGED) or invalid target'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	transfer(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.transfer(id, key, body)
	}
	@Post(ENDPOINTS.PRODUCTS.TYPED_DELETION)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_DELETION)
	@ApiBody({
		schema: {
			type: 'object',
			required: ['expected_revision'],
			properties: { expected_revision: { type: 'integer', minimum: 0 } }
		}
	})
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: TypedProductReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid product id, body or Idempotency-Key' })
	@ApiResponse({ status: 404, description: 'Product missing' })
	@ApiResponse({
		status: 409,
		description:
			'PRODUCT_DELETE_REQUIRES_INACTIVE (an active SKU — archive first), PRODUCT_IN_USE / VARIANT_IN_USE (orders, carts, old addresses), revision'
	})
	@ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
	remove(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.remove(id, key, body)
	}
	@Patch(ENDPOINTS.PRODUCTS.TYPED_DRAFT)
	@Header('Cache-Control', 'no-store')
	@ApiBody({ type: TypedProductEditDto })
	@ApiOperation(API_OPERATION.PRODUCTS.TYPED_DRAFT_EDIT)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: TypedProductReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid typed fields, axis or duplicate values.' })
	@ApiResponse({ status: 404, description: 'Product missing' })
	@ApiResponse({
		status: 409,
		description:
			'Revision, identity, SKU membership or draft conflict; PRODUCT_NOT_READY (with `details.issues`) when a SKU is asked to become active while the product is incomplete.'
	})
	@ApiResponse({
		status: 503,
		description: 'Draft writes disabled, busy or operation requires inspection.'
	})
	edit(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.edit(id, key, body)
	}
}
