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
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import { CatalogGateError } from 'src/database/mongoose/repositories/catalog-write-gate'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { CatalogRouteError, normalizeCatalogPath } from './catalog-route-plan'
import { CatalogRouteChangeError, CatalogRouteChangeWriter } from './catalog-route-writer'
import { CatalogConsistentRead } from '../catalog-safety/legacy-catalog-write.interceptor'

export class RouteSlugChangeDto {
	@ApiProperty({ minimum: 0 }) expected_revision!: number
	@ApiProperty({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 200 }) slug!: string
}
export class RouteChangeReceiptDto {
	@ApiProperty() operation_id!: string
	@ApiProperty() revision!: number
}
export class RouteResolutionDto {
	@ApiProperty({ enum: ['redirect'] }) kind!: 'redirect'
	@ApiProperty() path!: string
	@ApiProperty({ description: 'The entity’s current public address' }) target_path!: string
	@ApiProperty({ enum: [301] }) status!: 301
}

@Injectable()
export class CatalogRoutesService {
	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly categories: CategoryPublicReadService
	) {}

	/**
	 * PUBLIC. An old address → the entity's current public address (one 301, no chains). Only an
	 * alias of a visible entity answers; a hidden, draft or deleted target is a plain 404, never a
	 * redirect to a page that does not exist.
	 */
	async resolve(input: unknown) {
		const parsed = z.strictObject({ path: z.string().min(1).max(2048) }).safeParse(input)
		if (!parsed.success) throw new BadRequestException('Invalid path')
		let path: string
		try {
			path = normalizeCatalogPath(parsed.data.path)
		} catch (error) {
			if (error instanceof CatalogRouteError) throw new BadRequestException('Invalid path')
			throw error
		}
		const db = this.connection.db!
		const alias = await db.collection('catalog_routes').findOne({ path })
		if (!alias) throw new NotFoundException('Route not found')
		const target = await this.currentPath(
			alias.entity_type as string,
			alias.entity_id as mongo.ObjectId
		)
		if (!target || target === path) throw new NotFoundException('Route not found')
		return { kind: 'redirect' as const, path, target_path: target, status: 301 as const }
	}

	private async currentPath(type: string, id: mongo.ObjectId): Promise<string | null> {
		const db = this.connection.db!
		const visible = new Map(
			(await this.categories.findVisibleTree()).map(node => [node._id, node])
		)
		if (type === 'category')
			return visible.has(String(id)) ? `/${visible.get(String(id))!.slug}` : null
		if (type === 'landing') {
			const landing = await db.collection('landings').findOne({ _id: id, status: 'active' })
			const category = landing && visible.get(String(landing.category_id))
			if (!landing || !category) return null
			// Under a v2 category only a typed landing is public (the storefront's own rule).
			if (category.attribute_contract_version === 2 && landing.contract_version !== 2)
				return null
			return `/${category.slug}/${landing.slug as string}`
		}
		if (type === 'variant') {
			const variant = await db
				.collection('product_variants')
				.findOne({ _id: id, status: { $in: ['active', 'archived'] } })
			if (!variant || !visible.has(String(variant.category_id))) return null
			return `/products/${variant.slug as string}`
		}
		return null
	}

	async change(
		kind: 'variant' | 'category' | 'landing',
		id: string,
		key: string | undefined,
		body: unknown
	) {
		if (!/^[a-f0-9]{24}$/i.test(id)) throw new BadRequestException('Invalid ID')
		const uuid = z.string().uuid().safeParse(key)
		if (!uuid.success)
			throw new BadRequestException({ details: { code: 'INVALID_IDEMPOTENCY_KEY' } })
		try {
			// The body's shape is its own 400: every ZodError used to read as INVALID_SLUG, so a missing
			// revision or a stray field told the admin the address was wrong (audit 11.11). The slug
			// itself is validated by the writer.
			const parsed = z
				.strictObject({
					expected_revision: z.number().int().nonnegative().safe(),
					slug: z.unknown()
				})
				.safeParse(body)
			if (!parsed.success) throw new CatalogRouteChangeError('INVALID_ROUTE_FIELDS')
			const { expected_revision, slug } = parsed.data
			const writer = new CatalogRouteChangeWriter(this.connection.db!)
			const request = {
				operationId: uuid.data.toLowerCase(),
				ownerId: randomUUID(),
				expectedRevision: expected_revision
			}
			const receipt =
				kind === 'variant'
					? await writer.changeVariantSlug(request, id.toLowerCase(), slug)
					: kind === 'category'
						? await writer.changeCategorySlug(request, id.toLowerCase(), slug)
						: await writer.changeLandingSlug(request, id.toLowerCase(), slug)
			// Every reader of an address: listings, product pages, landings, sitemap, feed links.
			for (const resource of ['products', 'categories', 'landings'] as const)
				storefrontRevalidation.revalidate(resource, `${kind} slug change`)
			feedRefresh.request(`${kind} slug change`)
			return receipt
		} catch (error) {
			const code =
				error instanceof CatalogGateError || error instanceof CatalogRouteChangeError
					? error.code
					: error instanceof z.ZodError
						? 'INVALID_SLUG'
						: error instanceof CatalogRouteError
							? 'ROUTE_PATH_INVALID'
							: 'CATALOG_OPERATION_REQUIRES_INSPECTION'
			const response = {
				message: 'Не вдалося змінити адресу',
				details: { code, operation_id: uuid.data.toLowerCase() }
			}
			if (['INVALID_SLUG', 'INVALID_ROUTE_FIELDS', 'ROUTE_PATH_INVALID'].includes(code))
				throw new BadRequestException(response)
			if (code === 'ROUTE_ENTITY_NOT_FOUND') throw new NotFoundException(response)
			if (
				[
					'ROUTE_PATH_TAKEN',
					'ROUTE_PATH_RESERVED',
					'ROUTE_SLUG_UNCHANGED',
					'ROUTE_ENTITY_UNAVAILABLE',
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

const slugChangeDocs = (operation: { summary: string; description: string }) => [
	ApiOperation(operation),
	ApiBody({ type: RouteSlugChangeDto }),
	ApiHeader({
		name: 'Idempotency-Key',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	}),
	ApiOkResponse({ type: RouteChangeReceiptDto }),
	ApiResponse({
		status: 400,
		description: 'INVALID_SLUG; INVALID_ROUTE_FIELDS — body is not {expected_revision, slug}'
	}),
	ApiResponse({ status: 404, description: 'Entity missing' }),
	ApiResponse({
		status: 409,
		description: 'Address taken/reserved, unchanged or revision conflict'
	}),
	ApiResponse({ status: 503, description: 'Writes disabled, busy or recovery required' })
]
const apply =
	(decorators: MethodDecorator[]): MethodDecorator =>
	(target, key, descriptor) => {
		for (const decorator of decorators) decorator(target, key, descriptor)
	}

@Controller(ENDPOINTS.CATALOG_ROUTES.BASE)
@ApiTags(ENDPOINTS.CATALOG_ROUTES.BASE)
export class CatalogRoutesController {
	constructor(private readonly service: CatalogRoutesService) {}
	@Get(ENDPOINTS.CATALOG_ROUTES.RESOLVE)
	@CatalogConsistentRead()
	@ApiOperation(API_OPERATION.CATALOG_ROUTES.RESOLVE)
	@ApiQuery({ name: 'path', required: true, type: String })
	@ApiOkResponse({ type: RouteResolutionDto })
	@ApiResponse({ status: 404, description: 'No alias, or its entity is not public' })
	@ApiResponse({
		status: 400,
		description: 'Missing or ambiguous path (`//`, `..`, broken encoding) or an extra parameter'
	})
	@ApiResponse({ status: 503, description: 'Catalogue maintenance or a change during the read' })
	resolve(@Query() query: Record<string, unknown>) {
		return this.service.resolve(query)
	}
	@Post(ENDPOINTS.CATALOG_ROUTES.VARIANT_SLUG)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@apply(slugChangeDocs(API_OPERATION.CATALOG_ROUTES.VARIANT_SLUG))
	variant(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.change('variant', id, key, body)
	}
	@Post(ENDPOINTS.CATALOG_ROUTES.CATEGORY_SLUG)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@apply(slugChangeDocs(API_OPERATION.CATALOG_ROUTES.CATEGORY_SLUG))
	category(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.change('category', id, key, body)
	}
	@Post(ENDPOINTS.CATALOG_ROUTES.LANDING_SLUG)
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@apply(slugChangeDocs(API_OPERATION.CATALOG_ROUTES.LANDING_SLUG))
	landing(
		@Param('id') id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		return this.service.change('landing', id, key, body)
	}
}
