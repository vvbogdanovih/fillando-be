import { createHash, randomUUID } from 'node:crypto'
import {
	BadRequestException,
	Body,
	ConflictException,
	Controller,
	Header,
	Headers,
	Injectable,
	NotFoundException,
	Param,
	Post,
	ServiceUnavailableException,
	UseGuards
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import {
	ApiBody,
	ApiHeader,
	ApiOkResponse,
	ApiOperation,
	ApiProperty,
	ApiResponse,
	ApiTags
} from '@nestjs/swagger'
import { Allow } from 'class-validator'
import { Connection, mongo } from 'mongoose'
import { z } from 'zod'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
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
import { readCategoryConfiguration } from './category-configuration'
import { validateAttributes } from './attribute-definitions'
import { productReadiness } from '../product/product-readiness'

export class CategoryPublicationError extends Error {
	constructor(
		readonly code: string,
		/** What the admin needs to act on the refusal (e.g. the counts of a too large one). */
		readonly details: Record<string, unknown> = {}
	) {
		super(code)
		this.name = 'CategoryPublicationError'
	}
}

const commandSchema = z.strictObject({
	action: z.enum(['publish', 'unpublish']),
	expected_revision: z.number().int().nonnegative().safe()
})
type Command = z.infer<typeof commandSchema>

export interface PublicationReceipt {
	operation_id: string
	revision: number
	category_id: string
	action: Command['action']
	/** SKUs whose status this operation changed; null on a replayed receipt. */
	changed_variants: number | null
	/** Products left as drafts because their data is not ready; null on a replayed receipt. */
	skipped_products: { id: string; name: string; issues: string[] }[] | null
}

/**
 * Publication of a v2 category (Plan-0010, TD-0013 §6 «status»), through the same writer gate,
 * revision check, idempotency key and journal as every other tree write — no direct status
 * update, no transaction (standalone MongoDB).
 *
 * - **publish**: a draft node whose parent is already public (or a root) becomes active. For a
 *   product category, the draft SKUs of every product whose data passes the shop's readiness
 *   check become active in the same journal plan; a product that is not ready stays a draft and
 *   is reported. Archived SKUs stay archived. URLs, SKU codes and prices are not touched.
 * - **unpublish**: an active node without active children becomes a draft again, and its active
 *   SKUs return to draft, so the typed draft editor owns them again. It is the explicit inverse,
 *   not a deletion; historical orders keep their snapshots.
 *
 * Readiness is the shop's own data requirement — not a promise of indexing or Merchant approval.
 */
export class CategoryPublicationWriter {
	private readonly gate: CatalogWriteGate
	private readonly journal: CatalogMutationJournal
	constructor(private readonly db: mongo.Db) {
		this.gate = new CatalogWriteGate(db)
		this.journal = new CatalogMutationJournal(db, this.gate, 'publication')
	}

	private async plan(categoryId: string, action: Command['action']) {
		const categories = this.db.collection('categories')
		const category = await categories.findOne(
			{ _id: new mongo.ObjectId(categoryId) },
			{ readPreference: 'primary' }
		)
		if (!category) throw new CategoryPublicationError('CATEGORY_NOT_FOUND')
		const config = readCategoryConfiguration({
			...category,
			parent_id: category.parent_id == null ? null : String(category.parent_id)
		})
		if (config.attribute_contract_version !== 2)
			throw new CategoryPublicationError('CATALOG_CONTRACT_UPGRADE_REQUIRED')
		const from = action === 'publish' ? 'draft' : 'active'
		const to = action === 'publish' ? 'active' : 'draft'
		if (config.status !== from)
			throw new CategoryPublicationError(
				action === 'publish' ? 'CATEGORY_NOT_DRAFT' : 'CATEGORY_NOT_ACTIVE'
			)
		if (action === 'publish' && config.parent_id) {
			const parent = await categories.findOne(
				{ _id: new mongo.ObjectId(config.parent_id) },
				{ readPreference: 'primary', projection: { status: 1 } }
			)
			// Legacy rows without status are active; a parent is public only when active itself.
			if (!parent || (parent.status ?? 'active') !== 'active')
				throw new CategoryPublicationError('CATEGORY_PARENT_NOT_PUBLIC')
		}
		if (action === 'unpublish') {
			const activeChild = await categories.findOne(
				{
					parent_id: category._id,
					$or: [{ status: 'active' }, { status: { $exists: false } }]
				},
				{ readPreference: 'primary', projection: { _id: 1 } }
			)
			if (activeChild) throw new CategoryPublicationError('CATEGORY_HAS_ACTIVE_CHILDREN')
		}
		const image = (row: mongo.Document, key: string) =>
			Object.hasOwn(row, key)
				? { exists: true as const, value: row[key] as unknown }
				: { exists: false as const }
		const patches: CatalogPatch[] = [
			{
				collection: 'categories',
				id: categoryId,
				fields: {
					status: {
						before: image(category, 'status'),
						after: { exists: true, value: to }
					}
				}
			}
		]
		const skipped: NonNullable<PublicationReceipt['skipped_products']> = []
		if (config.kind === 'product') {
			const products = await this.db
				.collection('products')
				.find({ category_id: category._id }, { readPreference: 'primary' })
				.sort({ _id: 1 })
				.toArray()
			const variants = await this.db
				.collection('product_variants')
				.find(
					{ product_id: { $in: products.map(row => row._id) } },
					{ readPreference: 'primary' }
				)
				.sort({ _id: 1 })
				.toArray()
			for (const product of products) {
				const own = variants.filter(row => String(row.product_id) === String(product._id))
				if (own.some(row => String(row.category_id) !== categoryId))
					throw new CategoryPublicationError('TYPED_PRODUCT_DATA_UNAVAILABLE')
				const candidates = own.filter(row => row.status === from)
				if (!candidates.length) continue
				if (action === 'publish') {
					let issues: string[]
					const axisKey = (product.variant_axis as { key?: string } | null | undefined)
						?.key
					try {
						const attributes = validateAttributes(
							config.attribute_definitions!,
							(product.attributes_v2 ?? []) as never,
							{ active: false, axisKey }
						)
						issues = productReadiness({
							definitions: config.attribute_definitions!,
							attributes,
							axisKey,
							description: product.description as unknown,
							variants: own.map(row => ({
								id: String(row._id),
								status: row.status as string,
								price: row.price as unknown,
								stock: row.stock as unknown,
								images: row.images as unknown,
								weight_g: row.weight_g as unknown
							}))
						}).issues.map(issue => issue.code)
					} catch {
						issues = ['INVALID_TYPED_DATA']
					}
					// A colour axis stores the dictionary id on every SKU (`variant_value` = the id
					// of `color_id`), as the typed editor writes it; any other SKU carries none.
					// Refusing every `color_id` skipped the whole migrated filament on re-publication.
					const colorAxis =
						config.attribute_definitions!.find(definition => definition.key === axisKey)
							?.semantic === 'color'
					if (
						candidates.some(row =>
							colorAxis
								? !(row.color_id instanceof mongo.ObjectId) ||
									row.variant_value !== String(row.color_id)
								: row.color_id != null
						)
					)
						issues.push(colorAxis ? 'COLOR_AXIS_MISMATCH' : 'COLOR_ADAPTER_REQUIRED')
					if (issues.length) {
						skipped.push({
							id: String(product._id),
							name: String(product.name),
							issues: [...new Set(issues)]
						})
						continue
					}
				}
				for (const row of candidates)
					patches.push({
						collection: 'product_variants',
						id: String(row._id),
						fields: {
							status: {
								before: image(row, 'status'),
								after: { exists: true, value: to }
							}
						}
					})
			}
		}
		// The category is `patches[0]`; `run` writes the SKUs in parts when they do not fit one
		// operation (P13) and the category last.
		return { patches, skipped }
	}

	async run(
		request: { operationId: string; ownerId: string },
		categoryId: string,
		input: unknown
	): Promise<PublicationReceipt> {
		if (!/^[a-f0-9]{24}$/.test(categoryId))
			throw new CategoryPublicationError('CATEGORY_NOT_FOUND')
		const command = commandSchema.parse(input)
		const hash = createHash('sha256')
			.update(
				mongo.BSON.serialize({ type: 'category-publication', id: categoryId, ...command })
			)
			.digest('hex')
		const receipt = (
			revision: number,
			changed: number | null,
			skipped: PublicationReceipt['skipped_products']
		): PublicationReceipt => ({
			operation_id: request.operationId,
			revision,
			category_id: categoryId,
			action: command.action,
			changed_variants: changed,
			skipped_products: skipped
		})
		const previous = await this.gate.operation(request.operationId)
		if (previous) {
			if (previous.request_hash !== hash) throw new CatalogGateError('IDEMPOTENCY_KEY_REUSED')
			if (previous.status === 'completed' && previous.revision !== undefined)
				return receipt(previous.revision, null, null)
			throw new CatalogGateError('OPERATION_ALREADY_REGISTERED')
		}
		await this.assertEnabled()
		// More SKUs than one operation holds (P13, owner decision 02.11.2026): parts of SKUs first,
		// each its own journal operation under the gate, and the category with the rest last, under
		// the request's key. A published category's SKUs are hidden until that last operation (the
		// category is still a draft); an unpublished one's leave the listing first. A stop between
		// parts leaves only what a part wrote; publishing again plans from there and finishes.
		let expected = command.expected_revision
		let parts = 0
		let partSkus = 0
		while ((await this.plan(categoryId, command.action)).patches.length > PLAN_MAX_TARGETS) {
			const partId = randomUUID()
			const token = await this.gate.acquire(
				partId,
				createHash('sha256')
					.update(`${hash}:part:${request.operationId}:${parts}`)
					.digest('hex'),
				request.ownerId,
				expected
			)
			let started = false
			try {
				await this.assertEnabled()
				const { patches } = await this.plan(categoryId, command.action)
				if (patches.length <= PLAN_MAX_TARGETS) {
					// The rest fits after all (the catalogue changed): nothing to write in a part.
					await this.gate.afterFailedWrite(token, false)
					break
				}
				const part = patches.slice(1, 1 + PLAN_MAX_TARGETS)
				await this.journal.prepare(token, part)
				started = true
				await this.journal.execute(token, 'apply')
				const inspection = await this.journal.inspect(partId)
				if (inspection.counts.after + inspection.counts.both !== part.length)
					throw new CategoryPublicationError('PUBLICATION_VERIFICATION_FAILED')
				await this.gate.publishVerified(token)
				expected = token.revision + 1
				parts++
				partSkus += part.length
			} catch (error) {
				await this.gate.afterFailedWrite(token, started)
				throw error
			}
		}
		const token = await this.gate.acquire(request.operationId, hash, request.ownerId, expected)
		let started = false
		try {
			await this.assertEnabled()
			const { patches, skipped } = await this.plan(categoryId, command.action)
			if (patches.length > PLAN_MAX_TARGETS)
				// More SKUs became ready while the parts were written: the request is retried.
				throw new CategoryPublicationError('PUBLICATION_CHANGED')
			await this.journal.prepare(token, patches)
			started = true
			await this.journal.execute(token, 'apply')
			const inspection = await this.journal.inspect(request.operationId)
			if (inspection.counts.after + inspection.counts.both !== patches.length)
				throw new CategoryPublicationError('PUBLICATION_VERIFICATION_FAILED')
			await this.gate.publishVerified(token)
			return receipt(token.revision + 1, partSkus + patches.length - 1, skipped)
		} catch (error) {
			await this.gate.afterFailedWrite(token, started)
			throw error
		}
	}

	private async assertEnabled() {
		const enabled = await this.db
			.collection<{ _id: string }>('catalog_control')
			.findOne(
				{ _id: 'catalog', admin_draft_writes_enabled: true },
				{ readPreference: 'primary' }
			)
		if (!enabled) throw new CatalogGateError('CATALOG_DRAFT_WRITES_DISABLED')
	}
}

export class CategoryPublicationDto {
	@ApiProperty({ enum: ['publish', 'unpublish'] }) @Allow() action!: 'publish' | 'unpublish'
	@ApiProperty({ minimum: 0 }) @Allow() expected_revision!: number
}
export class SkippedProductDto {
	@ApiProperty() id!: string
	@ApiProperty() name!: string
	@ApiProperty({ type: [String] }) issues!: string[]
}
export class CategoryPublicationReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
	@ApiProperty() category_id!: string
	@ApiProperty({ enum: ['publish', 'unpublish'] }) action!: string
	@ApiProperty({ type: Number, nullable: true }) changed_variants!: number | null
	@ApiProperty({ type: [SkippedProductDto], nullable: true })
	skipped_products!: SkippedProductDto[] | null
}

@Injectable()
export class CategoryPublicationService {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	async run(categoryId: string, key: string | undefined, body: unknown) {
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({
				message: 'Потрібен Idempotency-Key UUID',
				details: { code: 'INVALID_IDEMPOTENCY_KEY' }
			})
		const operation_id = uuid.data.toLowerCase()
		try {
			const result = await new CategoryPublicationWriter(this.connection.db!).run(
				{ operationId: operation_id, ownerId: randomUUID() },
				categoryId.toLowerCase(),
				body
			)
			storefrontRevalidation.revalidate('categories', `category ${result.action}`)
			storefrontRevalidation.revalidate('products', `category ${result.action}`)
			return result
		} catch (error) {
			if (error instanceof z.ZodError)
				throw new BadRequestException({
					message: 'Некоректна команда публікації',
					details: { code: 'INVALID_PUBLICATION_COMMAND' }
				})
			const code =
				error instanceof CatalogGateError ||
				error instanceof CategoryPublicationError ||
				error instanceof CatalogJournalError
					? error.code
					: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
			const body = {
				message: 'Не вдалося змінити публікацію категорії',
				details: {
					code,
					operation_id,
					...(error instanceof CategoryPublicationError ? error.details : {})
				}
			}
			if (code === 'CATEGORY_NOT_FOUND') throw new NotFoundException(body)
			if (
				[
					'CATALOG_CONTRACT_UPGRADE_REQUIRED',
					'CATEGORY_NOT_DRAFT',
					'CATEGORY_NOT_ACTIVE',
					'CATEGORY_PARENT_NOT_PUBLIC',
					'CATEGORY_HAS_ACTIVE_CHILDREN',
					'PUBLICATION_CHANGED',
					'CATEGORY_REVISION_CONFLICT',
					'IDEMPOTENCY_KEY_REUSED',
					'OPERATION_ALREADY_REGISTERED'
				].includes(code)
			)
				throw new ConflictException(body)
			throw new ServiceUnavailableException(body)
		}
	}
}

@ApiTags(ENDPOINTS.CATEGORIES.BASE)
@Controller(ENDPOINTS.CATEGORIES.BASE)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CategoryPublicationController {
	constructor(private readonly service: CategoryPublicationService) {}
	@Post(ENDPOINTS.CATEGORIES.ADMIN_PUBLICATION)
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_PUBLICATION)
	@ApiBody({ type: CategoryPublicationDto })
	@ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	})
	@ApiOkResponse({ type: CategoryPublicationReceiptDto })
	@ApiResponse({ status: 404, description: 'Category missing' })
	@ApiResponse({
		status: 409,
		description:
			'Not v2, wrong status, parent not public, active children, revision or idempotency conflict; PUBLICATION_CHANGED (more SKUs became ready while a large publication was written in parts — publish again)'
	})
	@ApiResponse({
		status: 503,
		description: 'Writes disabled, busy or operation requires inspection'
	})
	run(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.run(id, key, body)
	}
}
