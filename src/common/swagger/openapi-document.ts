import type { INestApplication, Type } from '@nestjs/common'
import { RequestMethod } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { ModulesContainer } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger'
import { PartnerApiGuard } from 'src/modules/partner-api/partner-api.guard'
import { ROLES_KEY } from '../decorators/roles.decorator'
import { JwtAuthGuard } from '../guards/jwt-auth.guard'
import { INTERNAL_TOKEN_HEADER } from '../guards/internal-request.util'

/**
 * The access cookie's canonical name — `ACCSESS_TOKEN_NAME` of fillando-meta
 * `docs/runbooks/env-template.env` (and this repo's CLAUDE.md). The document never reads the
 * generating process's env: a local stand with another cookie name must not change the contract.
 */
export const ACCESS_COOKIE = 'access_token'

/** The security schemes of the document, by the name operations refer to them. */
export const SECURITY_SCHEMES = {
	cookie: 'access-cookie',
	partner: 'partner-token',
	internal: 'internal-token'
} as const
export type SecurityMark = 'public' | keyof typeof SECURITY_SCHEMES

const VERBS: Partial<Record<RequestMethod, string>> = {
	[RequestMethod.GET]: 'get',
	[RequestMethod.POST]: 'post',
	[RequestMethod.PUT]: 'put',
	[RequestMethod.PATCH]: 'patch',
	[RequestMethod.DELETE]: 'delete'
}
const list = <T>(value: T | T[] | undefined): T[] =>
	value === undefined ? [] : Array.isArray(value) ? value : [value]
const openApiPath = (...parts: string[]) =>
	`/${parts
		.flatMap(part => part.split('/'))
		.filter(Boolean)
		.join('/')}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

/**
 * What a route requires, read from its guards — the same metadata the request goes through, so
 * the document cannot drift from the code: `JwtAuthGuard` (class or handler) → the access cookie,
 * with the role from `@Roles`; `PartnerApiGuard` → the partner token; anything else (none,
 * throttling, `OptionalJwtAuthGuard`, Google OAuth) → public. No route requires the internal
 * token: it only exempts a request from the per-IP limits, so it is declared as a scheme and
 * named in the descriptions of the throttled routes, never required.
 */
function markOf(controller: Type<unknown>, handler: object) {
	const guards = [
		...list(Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined),
		...list(Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined)
	]
	const has = (guard: unknown) =>
		guards.some(item => item === guard || (item as object)?.constructor === guard)
	const roles = (Reflect.getMetadata(ROLES_KEY, handler) ??
		Reflect.getMetadata(ROLES_KEY, controller)) as string[] | undefined
	const mark: SecurityMark = has(PartnerApiGuard)
		? 'partner'
		: has(JwtAuthGuard)
			? 'cookie'
			: 'public'
	return { mark, roles: roles ?? [] }
}

/**
 * Every operation carries exactly one requirement: `[]` for a public route (overriding the
 * document's default), or one scheme. Admin routes name the role in their description.
 */
export function applyOperationSecurity(app: INestApplication, document: OpenAPIObject) {
	const modules = app.get(ModulesContainer)
	for (const module of modules.values())
		for (const wrapper of module.controllers.values()) {
			const controller = wrapper.metatype as Type<unknown> | undefined
			if (!controller?.prototype) continue
			const bases = list(Reflect.getMetadata(PATH_METADATA, controller) as string | string[])
			const prototype = controller.prototype as Record<string, unknown>
			for (const name of Object.getOwnPropertyNames(prototype)) {
				const handler = prototype[name]
				if (name === 'constructor' || typeof handler !== 'function') continue
				const verb = VERBS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod]
				const paths = Reflect.getMetadata(PATH_METADATA, handler) as
					| string
					| string[]
					| undefined
				if (!verb || paths === undefined) continue
				const { mark, roles } = markOf(controller, handler)
				for (const base of bases.length ? bases : [''])
					for (const path of list(paths)) {
						const operation = document.paths[openApiPath(base, path)]?.[
							verb as 'get'
						] as { security?: unknown[]; description?: string } | undefined
						if (!operation) continue
						operation.security =
							mark === 'public' ? [] : [{ [SECURITY_SCHEMES[mark]]: [] }]
						const note =
							mark === 'cookie'
								? roles.length
									? `Requires role: ${roles.join(', ')} (access cookie).`
									: 'Requires sign-in (access cookie).'
								: null
						if (note && !operation.description?.startsWith(note))
							operation.description = operation.description
								? `${note}\n\n${operation.description}`
								: note
					}
			}
		}
	return document
}

/**
 * The API document Swagger UI serves at `/swagger` and `yarn spec:export` writes to
 * `openapi.json`: the access cookie is the default requirement, public routes say `[]`
 * explicitly, the partner and internal tokens are their own schemes (owner decision 31.10.2026).
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
	const config = new DocumentBuilder()
		.setTitle('Fillando API')
		.setDescription('API документація')
		.setVersion('1.0')
		.addBearerAuth(
			{ type: 'http', scheme: 'bearer', bearerFormat: 'API token' },
			SECURITY_SCHEMES.partner
		)
		.addCookieAuth(
			ACCESS_COOKIE,
			{
				type: 'apiKey',
				in: 'cookie',
				name: ACCESS_COOKIE,
				description:
					'JWT access cookie set by POST /auth/login, /auth/register or Google sign-in (httpOnly); the browser sends it'
			},
			SECURITY_SCHEMES.cookie
		)
		.addApiKey(
			{
				type: 'apiKey',
				in: 'header',
				name: INTERNAL_TOKEN_HEADER,
				description:
					'INTERNAL_API_TOKEN of the storefront and the release probes: exempts a request from the per-IP rate limits; no route requires it'
			},
			SECURITY_SCHEMES.internal
		)
		.addSecurityRequirements(SECURITY_SCHEMES.cookie)
		.build()
	return applyOperationSecurity(app, SwaggerModule.createDocument(app, config))
}
