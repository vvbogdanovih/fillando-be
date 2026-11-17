import {
	CategoryFilterPreviewDto,
	CategoryFilterPreviewResultDto
} from './dto/category-filter-preview.dto'
import {
	parseAttributeFilters,
	attributeFilterResult,
	AttributeFilterRow,
	CategoryFilterError
} from './category-attribute-filters'
import {
	defaultProductDefinitions,
	validateAttributes,
	validateVariantValue
} from './attribute-definitions'
import {
	CategoryDefinitionsDto,
	CategoryConfigurationDto,
	DefinitionUsageDto
} from './dto/category-definitions.dto'
import { categoryControls } from './category-definition-editor'
import { AttributeContractError } from './attribute-definitions'
import { readCategoryConfiguration } from './category-configuration'
import { createHash, randomUUID } from 'node:crypto'
import {
	BadRequestException,
	Body,
	ConflictException,
	Controller,
	Headers,
	Header,
	HttpCode,
	Get,
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
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiResponse,
	ApiTags
} from '@nestjs/swagger'
import {
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsMongoId,
	IsOptional,
	IsString,
	IsUrl,
	IsUUID,
	Matches,
	MaxLength,
	MinLength,
	Max,
	Min,
	ValidateIf
} from 'class-validator'
import { z } from 'zod'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import {
	CatalogGateError,
	CatalogWriteGate
} from 'src/database/mongoose/repositories/catalog-write-gate'
import {
	CategoryIdentityConflict,
	CategoryTreeWriter,
	readCategoryData
} from './category-tree-writer'
import { CategoryConversionError, CategoryConversionWriter } from './category-conversion'
import { CategoryTreeError } from './category-tree'
import { DefinitionChangeError, definitionUsage } from './category-definition-change'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
export class DraftPlacementDto {
	@ApiProperty({ type: String, nullable: true })
	@ValidateIf((_object, value: unknown) => value !== null)
	@IsMongoId()
	parent_id!: string | null
	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	@IsInt()
	@Min(0)
	@Max(Number.MAX_SAFE_INTEGER)
	order!: number
	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	@IsInt()
	@Min(0)
	@Max(Number.MAX_SAFE_INTEGER)
	expected_revision!: number
}
export class DraftCreateDto extends DraftPlacementDto {
	@ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) name!: string
	@ApiProperty({ maxLength: 200 })
	@IsString()
	@MaxLength(200)
	@Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	slug!: string
	@ApiProperty({ enum: ['group', 'product'] }) @IsIn(['group', 'product']) kind!:
		| 'group'
		| 'product'
}
export class CategoryDetailsDto {
	@ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) name!: string
	@ApiProperty({
		type: String,
		nullable: true,
		required: false,
		maxLength: 2000,
		description: 'Tile image URL; omit to keep, null to remove'
	})
	@IsOptional()
	@ValidateIf((_object, value: unknown) => value !== null)
	@IsUrl()
	@MaxLength(2000)
	image?: string | null
	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	@IsInt()
	@Min(0)
	@Max(Number.MAX_SAFE_INTEGER)
	expected_revision!: number
}
export class DraftRevisionDto {
	@ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	@IsInt()
	@Min(0)
	@Max(Number.MAX_SAFE_INTEGER)
	expected_revision!: number
}
export class DraftConversionDto extends DraftRevisionDto {
	@ApiProperty({ enum: ['group', 'product'] }) @IsIn(['group', 'product']) kind!:
		| 'group'
		| 'product'
	@ApiProperty({
		required: false,
		format: 'uuid',
		description: 'A stored plan from conversion-plan (product → group with its distribution)'
	})
	@IsOptional()
	@IsUUID()
	plan_id?: string
}
export class ConversionAssignmentDto {
	@ApiProperty() product_id!: string
	@ApiProperty() target_category_id!: string
}
export class ConversionLandingAssignmentDto {
	@ApiProperty() landing_id!: string
	@ApiProperty() target_category_id!: string
}
export class ConversionPlanDto {
	@ApiProperty({ enum: ['group'] }) @IsIn(['group']) target_kind!: 'group'
	@ApiProperty({ type: [ConversionAssignmentDto], description: 'Every product exactly once' })
	@IsArray()
	assignments!: ConversionAssignmentDto[]
	@ApiProperty({
		type: [ConversionLandingAssignmentDto],
		required: false,
		description: 'Every landing of the category exactly once'
	})
	@IsOptional()
	@IsArray()
	landing_assignments?: ConversionLandingAssignmentDto[]
	@ApiProperty({
		required: false,
		description: 'Also move the target categories under the new group (same plan)'
	})
	@IsOptional()
	@IsBoolean()
	adopt_targets?: boolean
}
export class ConversionPlanResultDto {
	@ApiProperty({ type: String, nullable: true, format: 'uuid' }) plan_id!: string | null
	@ApiProperty() category_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() executable!: boolean
	@ApiProperty({
		description:
			'products, variants, landings, targets, variants_to_draft, routes (new aliases), patches'
	})
	counts!: Record<string, number>
	@ApiProperty({
		description: 'product_id, name, target_category_id, mapped (characteristics), variants'
	})
	products!: Record<string, unknown>[]
	@ApiProperty({
		description: 'landing_id, slug, status, target_category_id, from_path, to_path'
	})
	landings!: Record<string, unknown>[]
	@ApiProperty({
		description:
			'code (CONVERSION_PRODUCT_LOSES_VALUES, CONVERSION_PRODUCT_AXIS, CONVERSION_PRODUCT_MISSING_REQUIRED, CONVERSION_PRODUCT_INVALID, CONVERSION_DATA_INCONSISTENT, CONVERSION_LANDING_NOT_TYPED, CONVERSION_LANDING_PINS, CONVERSION_LANDING_SLUG_TAKEN, CONVERSION_LANDING_PINS_DUPLICATE, ROUTE_PATH_TAKEN, CATEGORY_PARENT_NOT_PUBLIC, CONVERSION_PLAN_TOO_LARGE), product_id/landing_id/target_category_id, dropped, missing_required, detail; CONVERSION_PLAN_TOO_LARGE: detail = changes, limit = the most one operation holds'
	})
	problems!: Record<string, unknown>[]
	@ApiProperty({
		description:
			'code (CONVERSION_ACTIVE_SKUS_TO_DRAFT, CONVERSION_LANDING_HIDDEN, CONVERSION_LANDING_TARGET_EMPTY, CONVERSION_SETTINGS_NOT_CARRIED), landing_id, target_category_id, count'
	})
	warnings!: Record<string, unknown>[]
}
export class DraftCapabilitiesDto {
	@ApiProperty() draft_writes_enabled!: boolean
	@ApiProperty() legacy_writes_enabled!: boolean
}
export class DraftPlacementReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() category_id!: string
}
export class CatalogOperationStatusDto {
	@ApiProperty() operation_id!: string
	@ApiProperty({
		enum: ['pending', 'completed', 'rejected', 'aborted', 'rolled_back', 'recovery_required']
	})
	status!: string
	@ApiProperty({ type: Number, nullable: true }) result_revision!: number | null
	@ApiProperty({ type: String, nullable: true }) error_code!: string | null
}

@Injectable()
export class CategoryDraftPlacementService {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	async status(key: string): Promise<CatalogOperationStatusDto> {
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success) throw new BadRequestException('Invalid operation UUID')
		const operationId = uuid.data.toLowerCase()
		const operation = await new CatalogWriteGate(this.connection.db!).operation(operationId)
		if (!operation) throw new NotFoundException('Operation not found')
		const control = await this.connection
			.db!.collection<{
				_id: string
				operation_id?: string
				phase?: string
			}>('catalog_control')
			.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		const recovering =
			control?.operation_id === operationId &&
			['recovering', 'recovery_required'].includes(control.phase ?? '')
		return {
			operation_id: operationId,
			status:
				operation.status === 'claimed'
					? recovering
						? 'recovery_required'
						: 'pending'
					: operation.status,
			result_revision: operation.revision ?? null,
			error_code: operation.error ?? null
		}
	}

	async configuration(categoryId: string): Promise<CategoryConfigurationDto> {
		this.assertId(categoryId)
		const db = this.connection.db!
		const gate = new CatalogWriteGate(db)
		try {
			const before = await gate.readStamp()
			if (!Number.isSafeInteger(before.revision) || !Number.isSafeInteger(before.epoch))
				throw new CatalogGateError('CATALOG_MAINTENANCE')
			const row = await db
				.collection('categories')
				.findOne({ _id: new mongo.ObjectId(categoryId) }, { readPreference: 'primary' })
			if (!row) throw new NotFoundException('Category not found')
			const config = readCategoryConfiguration({
				...row,
				parent_id: row.parent_id == null ? null : String(row.parent_id)
			})
			if (config.attribute_contract_version !== 2)
				throw new ConflictException({
					message: 'Спершу потрібна міграція категорії',
					details: { code: 'CATALOG_CONTRACT_UPGRADE_REQUIRED' }
				})
			await gate.assertReadUnchanged(before)
			const definitions = config.attribute_definitions!
			return {
				category_id: categoryId.toLowerCase(),
				revision: before.revision,
				kind: config.kind,
				status: config.status,
				definitions,
				controls: categoryControls(definitions)
			}
		} catch (error) {
			if (error instanceof NotFoundException || error instanceof ConflictException)
				throw error
			throw new ServiceUnavailableException({
				message: 'Налаштування каталогу зараз недоступні',
				details: {
					code:
						error instanceof CatalogGateError
							? error.code
							: 'CATALOG_CONFIGURATION_UNAVAILABLE'
				}
			})
		}
	}
	async preview(
		categoryId: string,
		dto: CategoryFilterPreviewDto
	): Promise<CategoryFilterPreviewResultDto> {
		const config = await this.configuration(categoryId)
		if (config.kind !== 'product') throw new ConflictException('Product category required')
		const db = this.connection.db!,
			gate = new CatalogWriteGate(db)
		try {
			const stamp = await gate.readStamp()
			if (stamp.revision !== config.revision)
				throw new CatalogGateError('CATALOG_READ_CHANGED')
			// DTO classes expose absent fields as undefined; strip them before the strict union parser.
			const filters = parseAttributeFilters(
				config.definitions,
				JSON.parse(JSON.stringify(dto))
			)
			const ids = [categoryId.toLowerCase(), new mongo.ObjectId(categoryId)]
			const products = await db
				.collection('products')
				.find(
					{ category_id: { $in: ids } },
					{
						readPreference: 'primary',
						projection: { _id: 1, attributes_v2: 1, variant_axis: 1 }
					}
				)
				.limit(5001)
				.toArray()
			const variants = await db
				.collection('product_variants')
				.find(
					{ category_id: { $in: ids }, status: { $in: ['active', 'draft'] } },
					{
						readPreference: 'primary',
						projection: { _id: 1, product_id: 1, variant_value: 1 }
					}
				)
				.limit(20001)
				.toArray()
			if (products.length > 5000 || variants.length > 20000)
				throw new CategoryFilterError('PREVIEW_LIMIT_EXCEEDED')
			const byProduct = new Map(products.map(product => [String(product._id), product]))
			const rows: AttributeFilterRow[] = variants.map(variant => {
				const product = byProduct.get(String(variant.product_id))
				if (!product) throw Error('INCONSISTENT_VARIANT_CATEGORY')
				const axis = z
					.object({ key: z.string() })
					.nullable()
					.parse(product.variant_axis ?? null)
				const attributes = validateAttributes(config.definitions, product.attributes_v2, {
					active: false,
					axisKey: axis?.key
				})
				if (axis)
					attributes.push({
						k: axis.key,
						v: validateVariantValue(config.definitions, axis.key, variant.variant_value)
					})
				return { id: String(variant._id), product_id: String(product._id), attributes }
			})
			const result = attributeFilterResult(config.definitions, rows, filters)
			await gate.assertReadUnchanged(stamp)
			return { category_id: categoryId.toLowerCase(), revision: stamp.revision, ...result }
		} catch (error) {
			if (error instanceof CategoryFilterError)
				throw new BadRequestException({
					message: 'Перевірте фільтри або обсяг попереднього перегляду',
					details: { code: error.code }
				})
			throw new ServiceUnavailableException({
				message: 'Попередній перегляд недоступний до підготовки даних категорії',
				details: {
					code:
						error instanceof CatalogGateError
							? error.code
							: 'CATALOG_PREVIEW_DATA_UNAVAILABLE'
				}
			})
		}
	}

	async definitions(categoryId: string, key: string | undefined, dto: CategoryDefinitionsDto) {
		this.assertId(categoryId)
		const receipt = await this.execute(key, dto.expected_revision, (writer, context) =>
			writer.replaceDefinitions(context, {
				id: categoryId.toLowerCase(),
				definitions: dto.definitions
			})
		)
		await this.revalidatePublished(categoryId, 'category definitions')
		return receipt
	}

	/** Exact per-key usage for the editor, one verified snapshot (Plan-0010 F03). */
	async definitionUsage(categoryId: string): Promise<DefinitionUsageDto> {
		this.assertId(categoryId)
		const db = this.connection.db!
		const gate = new CatalogWriteGate(db)
		try {
			const stamp = await gate.readStamp()
			const id = categoryId.toLowerCase()
			const row = await db
				.collection('categories')
				.findOne({ _id: new mongo.ObjectId(id) }, { readPreference: 'primary' })
			if (!row) throw new NotFoundException('Category not found')
			const config = readCategoryConfiguration({
				...row,
				parent_id: row.parent_id == null ? null : String(row.parent_id)
			})
			if (config.attribute_contract_version !== 2 || config.kind !== 'product')
				throw new ConflictException({
					message: 'Характеристики є лише в товарній категорії нового каталогу',
					details: { code: 'CATEGORY_DEFINITIONS_REQUIRE_PRODUCT' }
				})
			const usage = definitionUsage(
				config.attribute_definitions!,
				await readCategoryData(db, id)
			)
			await gate.assertReadUnchanged(stamp)
			return {
				category_id: id,
				revision: stamp.revision,
				published: row.status === 'active',
				products: usage.products,
				keys: Object.entries(usage.keys).map(([key, value]) => ({
					key,
					products: value.products,
					variants: value.variants,
					landings: value.landings,
					pins: value.pins,
					missing: value.missing,
					options: Object.entries(value.options).map(([option, count]) => ({
						id: option,
						...count
					}))
				}))
			}
		} catch (error) {
			if (error instanceof NotFoundException || error instanceof ConflictException)
				throw error
			throw new ServiceUnavailableException({
				message: 'Використання характеристик зараз недоступне',
				details: {
					code:
						error instanceof CatalogGateError
							? error.code
							: 'CATALOG_CONFIGURATION_UNAVAILABLE'
				}
			})
		}
	}

	/** A published category is on the storefront and in the feed: purge both after a write. */
	private async revalidatePublished(categoryId: string, trigger: string) {
		const row = await this.connection
			.db!.collection('categories')
			.findOne(
				{ _id: new mongo.ObjectId(categoryId.toLowerCase()) },
				{ projection: { status: 1 }, readPreference: 'primary' }
			)
		if (row?.status !== 'active') return
		for (const resource of ['categories', 'products', 'landings'] as const)
			storefrontRevalidation.revalidate(resource, trigger)
		feedRefresh.request(trigger)
	}

	async capabilities(): Promise<DraftCapabilitiesDto> {
		const control = await this.connection
			.db!.collection<{
				_id: string
				admin_draft_writes_enabled?: boolean
				phase?: string
			}>('catalog_control')
			.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		return {
			draft_writes_enabled:
				control?.admin_draft_writes_enabled === true && control.phase === 'idle',
			legacy_writes_enabled: !control
		}
	}
	async create(key: string | undefined, dto: DraftCreateDto) {
		return this.execute(key, dto.expected_revision, (writer, context) =>
			writer.create(context, {
				id: createHash('sha256')
					.update(`category:${context.operationId}`)
					.digest('hex')
					.slice(0, 24),
				name: dto.name,
				slug: dto.slug,
				kind: dto.kind,
				parent_id: dto.parent_id?.toLowerCase() ?? null,
				order: dto.order,
				attribute_definitions: dto.kind === 'product' ? defaultProductDefinitions() : []
			})
		)
	}
	async details(categoryId: string, key: string | undefined, dto: CategoryDetailsDto) {
		this.assertId(categoryId)
		const receipt = await this.execute(key, dto.expected_revision, (writer, context) =>
			writer.updateDetails(context, {
				id: categoryId.toLowerCase(),
				name: dto.name,
				...(dto.image !== undefined ? { image: dto.image } : {})
			})
		)
		await this.revalidatePublished(categoryId, 'category details')
		return receipt
	}
	async move(categoryId: string, key: string | undefined, dto: DraftPlacementDto) {
		this.assertId(categoryId)
		const receipt = await this.execute(key, dto.expected_revision, (writer, context) =>
			writer.moveDraft(context, {
				id: categoryId.toLowerCase(),
				parent_id: dto.parent_id?.toLowerCase() ?? null,
				order: dto.order
			})
		)
		// A published category's place (order or group) shows in the menu, /catalog and every
		// breadcrumb of its branch; addresses never change.
		await this.revalidatePublished(categoryId, 'category placement')
		return receipt
	}
	async remove(categoryId: string, key: string | undefined, dto: DraftRevisionDto) {
		this.assertId(categoryId)
		return this.execute(key, dto.expected_revision, (writer, context) =>
			writer.deleteDraft(context, categoryId.toLowerCase())
		)
	}
	async convert(categoryId: string, key: string | undefined, dto: DraftConversionDto) {
		this.assertId(categoryId)
		if (dto.plan_id) {
			if (dto.kind !== 'group')
				throw new BadRequestException({
					message: 'План розподілу перетворює товарну категорію лише на групу',
					details: { code: 'CONVERSION_KIND_UNSUPPORTED' }
				})
			const receipt = await this.execute(key, dto.expected_revision, (_writer, context) =>
				this.conversion(() =>
					new CategoryConversionWriter(this.connection.db!).execute(
						{
							operationId: context.operationId,
							ownerId: context.ownerId,
							expectedRevision: context.expectedRevision
						},
						categoryId.toLowerCase(),
						dto.plan_id!
					)
				)
			)
			// Products, SKUs and landings changed category; menus, breadcrumbs and pages follow.
			for (const resource of ['categories', 'products', 'landings'] as const)
				storefrontRevalidation.revalidate(resource, 'category conversion')
			feedRefresh.request('category conversion')
			return receipt
		}
		// A group never holds definitions; a new product category starts with the default brand
		// and is configured in the definitions editor.
		return this.execute(key, dto.expected_revision, (writer, context) =>
			writer.convertDraft(context, {
				id: categoryId.toLowerCase(),
				kind: dto.kind,
				attribute_definitions: dto.kind === 'product' ? defaultProductDefinitions() : []
			})
		)
	}

	/** Read-only check of a product category → group distribution (TD-0013 mutations §5). */
	async conversionPlan(categoryId: string, dto: ConversionPlanDto) {
		this.assertId(categoryId)
		try {
			return await this.conversion(() =>
				new CategoryConversionWriter(this.connection.db!).plan(
					categoryId.toLowerCase(),
					JSON.parse(JSON.stringify(dto))
				)
			)
		} catch (error) {
			if (error instanceof z.ZodError)
				throw new BadRequestException({
					message: 'Перевірте розподіл товарів і посадкових сторінок',
					details: { code: 'CONVERSION_REQUEST_INVALID' }
				})
			if (error instanceof CatalogGateError)
				throw new ServiceUnavailableException({
					message: 'Каталог зараз недоступний для перевірки плану',
					details: { code: error.code }
				})
			throw error
		}
	}

	/** Coded conversion refusals as HTTP errors with their details; anything else passes on. */
	private async conversion<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action()
		} catch (error) {
			if (!(error instanceof CategoryConversionError)) throw error
			const body = {
				message: 'Перетворення категорії відхилено',
				details: { code: error.code, ...error.details }
			}
			if (error.code === 'CONVERSION_ASSIGNMENTS_INVALID') throw new BadRequestException(body)
			if (['CATEGORY_NOT_FOUND', 'CONVERSION_PLAN_NOT_FOUND'].includes(error.code))
				throw new NotFoundException(body)
			throw new ConflictException(body)
		}
	}
	private assertId(categoryId: string) {
		if (!/^[a-f0-9]{24}$/i.test(categoryId))
			throw new BadRequestException('Invalid category ID')
	}
	private async execute(
		key: string | undefined,
		expectedRevision: number,
		action: (
			writer: CategoryTreeWriter,
			context: import('./category-tree-writer').CategoryWriteRequest
		) => Promise<DraftPlacementReceiptDto>
	) {
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({
				message: 'Потрібен Idempotency-Key UUID',
				details: { code: 'INVALID_IDEMPOTENCY_KEY' }
			})
		const db = this.connection.db!
		const enabled = await db
			.collection<{
				_id: string
				admin_draft_writes_enabled?: boolean
				phase?: string
			}>('catalog_control')
			.findOne(
				{ _id: 'catalog', admin_draft_writes_enabled: true },
				{ readPreference: 'primary' }
			)
		if (!enabled)
			throw new ServiceUnavailableException({
				message: 'Записи дерева ще не ввімкнені',
				details: { code: 'CATALOG_DRAFT_WRITES_DISABLED' }
			})
		try {
			return await action(new CategoryTreeWriter(db), {
				operationId: uuid.data.toLowerCase(),
				ownerId: randomUUID(),
				expectedRevision,
				requireDraftWrites: true
			})
		} catch (error) {
			if (
				error instanceof BadRequestException ||
				error instanceof NotFoundException ||
				error instanceof ConflictException
			)
				throw error
			if (error instanceof z.ZodError)
				throw new BadRequestException({
					message: 'Перевірте поля налаштувань',
					details: { code: 'INVALID_DEFINITION' }
				})
			if (error instanceof AttributeContractError)
				throw new BadRequestException({
					message: 'Зміна характеристик відхилена',
					details: { code: error.code, field: error.field }
				})
			if (error instanceof DefinitionChangeError)
				throw new ConflictException({
					message: 'Зміна характеристик відхилена: вона зачепила б наявні дані',
					details: {
						code: error.code,
						key: error.key,
						label: error.label,
						option: error.option,
						usage: error.usage,
						operation_id: uuid.data.toLowerCase()
					}
				})
			const code =
				error instanceof CatalogGateError || error instanceof CategoryTreeError
					? error.code
					: error instanceof Error
						? error.message
						: 'UNKNOWN'
			const body = {
				message: 'Не вдалося змінити категорію',
				details: {
					code,
					operation_id: uuid.data.toLowerCase(),
					...(error instanceof CategoryIdentityConflict
						? { conflict: error.conflict }
						: {})
				}
			}
			if (['CATEGORY_NOT_FOUND', 'UNKNOWN_CATEGORY', 'UNKNOWN_PARENT'].includes(code))
				throw new NotFoundException(body)
			if (
				[
					'CATEGORY_CYCLE',
					'PARENT_NOT_GROUP',
					'CATEGORY_REVISION_CONFLICT',
					'IDEMPOTENCY_KEY_REUSED',
					'OPERATION_ALREADY_REGISTERED',
					'CATALOG_CONTRACT_UPGRADE_REQUIRED',
					'CATEGORY_PARENT_NOT_PUBLIC',
					'CATEGORY_ARCHIVED',
					'CATEGORY_DETAILS_UNCHANGED',
					'CATEGORY_IDENTITY_CONFLICT',
					'ROUTE_PATH_RESERVED',
					'ROUTE_PATH_TAKEN',
					'CATEGORY_DEFINITIONS_REQUIRE_PRODUCT',
					'CATEGORY_DELETE_REQUIRES_DRAFT',
					'CATEGORY_CONVERSION_REQUIRES_DRAFT',
					'CATEGORY_KIND_UNCHANGED',
					'CATEGORY_IN_USE'
				].includes(code)
			)
				throw new ConflictException(body)
			if (
				[
					'CATALOG_WRITE_IN_PROGRESS',
					'CATALOG_CONTROL_MISSING',
					'CATALOG_DRAFT_WRITES_DISABLED'
				].includes(code)
			)
				throw new ServiceUnavailableException(body)
			throw new ServiceUnavailableException({
				message: 'Операція потребує перевірки; збережіть її ключ',
				details: {
					code: 'CATALOG_OPERATION_REQUIRES_INSPECTION',
					operation_id: uuid.data.toLowerCase()
				}
			})
		}
	}
}
@ApiTags(ENDPOINTS.CATEGORIES.BASE)
@Controller(ENDPOINTS.CATEGORIES.BASE)
export class CategoryDraftPlacementController {
	constructor(private readonly service: CategoryDraftPlacementService) {}
	@Post(ENDPOINTS.CATEGORIES.ADMIN_FILTER_PREVIEW)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_FILTER_PREVIEW)
	@ApiResponse({ status: 200, type: CategoryFilterPreviewResultDto })
	@ApiResponse({ status: 400, description: 'Invalid filters or bounded preview limit exceeded' })
	@ApiResponse({ status: 503, description: 'Read changed or typed data not ready' })
	preview(@Param('id') id: string, @Body() dto: CategoryFilterPreviewDto) {
		return this.service.preview(id, dto)
	}

	@Get(ENDPOINTS.CATEGORIES.ADMIN_CONFIGURATION)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_CONFIGURATION)
	@ApiOkResponse({ type: CategoryConfigurationDto })
	@ApiResponse({ status: 409, description: 'Legacy category requires migration' })
	@ApiResponse({ status: 503, description: 'Catalog busy, missing control or read changed' })
	configuration(@Param('id') id: string) {
		return this.service.configuration(id)
	}

	@Get(ENDPOINTS.CATEGORIES.ADMIN_DEFINITION_USAGE)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_DEFINITION_USAGE)
	@ApiOkResponse({ type: DefinitionUsageDto })
	@ApiResponse({ status: 409, description: 'Not a v2 product category' })
	@ApiResponse({ status: 503, description: 'Catalog busy, missing control or read changed' })
	definitionUsage(@Param('id') id: string) {
		return this.service.definitionUsage(id)
	}

	@Patch(ENDPOINTS.CATEGORIES.ADMIN_DEFINITIONS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_DEFINITIONS)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: DraftPlacementReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid definitions or foreign identities' })
	@ApiResponse({
		status: 409,
		description:
			'Revision/contract conflict, archived category, or a change refused by the exact usage (DEFINITION_IN_USE, DEFINITION_TYPE_LOCKED, DEFINITION_UNIT_LOCKED, OPTION_IN_USE, FILTER_PINNED, REQUIRED_VALUES_MISSING, DEFINITION_CHANGE_INVALIDATES_DATA) with details.key/label/option/usage'
	})
	@ApiResponse({ status: 503, description: 'Disabled, busy or recovery required' })
	definitions(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CategoryDefinitionsDto
	) {
		return this.service.definitions(id, key, dto)
	}

	@Get(ENDPOINTS.CATEGORIES.ADMIN_CAPABILITIES)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_CAPABILITIES)
	@ApiOkResponse({ type: DraftCapabilitiesDto })
	capabilities() {
		return this.service.capabilities()
	}

	@Post(ENDPOINTS.CATEGORIES.DRAFT_CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.DRAFT_CREATE)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiResponse({ status: 201, type: DraftPlacementReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid input' })
	@ApiResponse({
		status: 409,
		description:
			'Revision or topology conflict; CATEGORY_IDENTITY_CONFLICT with details.conflict {field: name|slug, category {id, name, slug}} — the category that has the name or address; ROUTE_PATH_RESERVED / ROUTE_PATH_TAKEN'
	})
	@ApiResponse({ status: 503, description: 'Disabled, busy or recovery required' })
	create(@Headers('idempotency-key') key: string | undefined, @Body() dto: DraftCreateDto) {
		return this.service.create(key, dto)
	}

	@Patch(ENDPOINTS.CATEGORIES.ADMIN_DETAILS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_DETAILS)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: DraftPlacementReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid input' })
	@ApiResponse({ status: 404, description: 'Category missing' })
	@ApiResponse({
		status: 409,
		description:
			'Revision conflict; CATEGORY_IDENTITY_CONFLICT with details.conflict {field: name, category {id, name, slug}} — the category that has the name; archived category; nothing changed (CATEGORY_DETAILS_UNCHANGED)'
	})
	@ApiResponse({ status: 503, description: 'Disabled, busy or recovery required' })
	details(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CategoryDetailsDto
	) {
		return this.service.details(id, key, dto)
	}

	@Post(ENDPOINTS.CATEGORIES.DRAFT_DELETION)
	@HttpCode(200)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.DRAFT_DELETION)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: DraftPlacementReceiptDto })
	@ApiResponse({ status: 404, description: 'Category missing' })
	@ApiResponse({
		status: 409,
		description:
			'Not a v2 draft (CATEGORY_DELETE_REQUIRES_DRAFT), in use (CATEGORY_IN_USE) or revision conflict'
	})
	@ApiResponse({ status: 503, description: 'Disabled, busy or recovery required' })
	remove(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: DraftRevisionDto
	) {
		return this.service.remove(id, key, dto)
	}

	@Post(ENDPOINTS.CATEGORIES.DRAFT_CONVERSION)
	@HttpCode(200)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.DRAFT_CONVERSION)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: DraftPlacementReceiptDto })
	@ApiResponse({ status: 404, description: 'Category missing' })
	@ApiResponse({
		status: 409,
		description:
			'Not a v2 draft, same kind (CATEGORY_KIND_UNCHANGED), not empty (CATEGORY_IN_USE), revision conflict; with plan_id: CONVERSION_PLAN_STALE, CONVERSION_PLAN_CHANGED, CONVERSION_PLAN_BLOCKED'
	})
	@ApiResponse({ status: 503, description: 'Disabled, busy or recovery required' })
	convert(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: DraftConversionDto
	) {
		return this.service.convert(id, key, dto)
	}

	@Post(ENDPOINTS.CATEGORIES.ADMIN_CONVERSION_PLAN)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.CONVERSION_PLAN)
	@ApiOkResponse({ type: ConversionPlanResultDto })
	@ApiResponse({
		status: 400,
		description: 'Not every product/landing assigned exactly once, or malformed request'
	})
	@ApiResponse({ status: 404, description: 'Category missing' })
	@ApiResponse({
		status: 409,
		description:
			'Not a v2 product category, archived, or an invalid target (CONVERSION_TARGET_INVALID)'
	})
	@ApiResponse({ status: 503, description: 'Disabled, busy or recovery required' })
	conversionPlan(@Param('id') id: string, @Body() dto: ConversionPlanDto) {
		return this.service.conversionPlan(id, dto)
	}

	@Patch(ENDPOINTS.CATEGORIES.DRAFT_PLACEMENT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.DRAFT_PLACEMENT)
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: DraftPlacementReceiptDto })
	@ApiResponse({ status: 400, description: 'Invalid input/key' })
	@ApiResponse({ status: 404, description: 'Category or parent missing' })
	@ApiResponse({ status: 409, description: 'Revision/topology/contract/idempotency conflict' })
	@ApiResponse({
		status: 503,
		description: 'Disabled until explicit rollout preparation, busy or recovery required'
	})
	move(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: DraftPlacementDto
	) {
		return this.service.move(id, key, dto)
	}
}

@ApiTags(ENDPOINTS.CATALOG_OPERATIONS.BASE)
@Controller(ENDPOINTS.CATALOG_OPERATIONS.BASE)
export class CatalogOperationController {
	constructor(private readonly service: CategoryDraftPlacementService) {}
	@Header('Cache-Control', 'no-store')
	@Get(ENDPOINTS.CATALOG_OPERATIONS.STATUS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATALOG_OPERATIONS.STATUS)
	@ApiOkResponse({ type: CatalogOperationStatusDto })
	@ApiResponse({ status: 404, description: 'Operation not found' })
	status(@Param('id') id: string) {
		return this.service.status(id)
	}
}
