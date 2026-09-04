import {
	CanActivate,
	ExecutionContext,
	INestApplication,
	Provider,
	Type,
	UnauthorizedException,
	ModuleMetadata
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import type { Server } from 'node:http'
import type { Request } from 'express'
import request from 'supertest'
import { JwtAuthGuard } from '../guards/jwt-auth.guard'
import type { JWTPayload } from '../types/jwt-payload'

/** Header the fake auth guard reads the caller's role from. Omit it to simulate an anonymous request. */
export const TEST_ROLE_HEADER = 'x-test-role'

/**
 * Stand-in for `JwtAuthGuard` in controller-level RBAC specs.
 *
 * Instead of verifying a JWT it reads `x-test-role`: no header → 401 (exactly what the
 * real guard does for a missing/invalid token); header present → `req.user` is populated
 * the way the passport strategy would populate it. `RolesGuard` is deliberately left real,
 * so a spec exercises the actual guard chain rather than a copy of it.
 */
export class HeaderRoleAuthGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const req = context.switchToHttp().getRequest<Request & { user?: JWTPayload }>()
		const role = req.header(TEST_ROLE_HEADER)
		if (!role) {
			throw new UnauthorizedException()
		}
		req.user = { id: 'u1', email: 'u1@test.invalid', name: 'Test', role }
		return true
	}
}

export type RbacAppOptions = {
	controllers: Type<unknown>[]
	providers: Provider[]
	/** Extra modules (e.g. `ThrottlerModule.forRoot(...)`) the controller's guards need. */
	imports?: ModuleMetadata['imports']
}

/**
 * Boots a minimal Nest app with the given controllers/providers and `JwtAuthGuard`
 * replaced by `HeaderRoleAuthGuard`. Global pipes from `main.ts` are NOT registered on
 * purpose — these specs test guards, not DTO validation, so empty bodies must pass.
 */
/**
 * Controllers that rate-limit a handler inject `ThrottlerGuard`, which needs the throttler
 * module. A permissive default keeps RBAC specs independent of the real limits; a spec that
 * tests throttling passes its own `imports` with the real configuration.
 */
const DEFAULT_IMPORTS = [
	ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 10_000 }] })
]

export async function createRbacApp({
	controllers,
	providers,
	imports = DEFAULT_IMPORTS
}: RbacAppOptions): Promise<INestApplication> {
	const moduleRef = await Test.createTestingModule({ imports, controllers, providers })
		.overrideGuard(JwtAuthGuard)
		.useValue(new HeaderRoleAuthGuard())
		.compile()

	const app = moduleRef.createNestApplication({ logger: false })
	await app.init()
	return app
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete'

export type SendOptions = {
	/** Value for `x-test-role`; leave undefined for an anonymous (401) request. */
	role?: string
	/** JSON body; leave undefined to send no body at all. */
	body?: unknown
}

/**
 * `send(app, 'post', '/products', { role: 'ADMIN', body: {} })` is shorthand for
 * `request(app.getHttpServer()).post('/products').set('x-test-role', 'ADMIN').send({})`.
 */
export function send(
	app: INestApplication,
	method: HttpMethod,
	path: string,
	{ role, body }: SendOptions = {}
): request.Test {
	const server = app.getHttpServer() as Server
	let req = request(server)[method](path)
	if (role !== undefined) {
		req = req.set(TEST_ROLE_HEADER, role)
	}
	return body === undefined ? req : req.send(body as object)
}
