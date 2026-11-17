import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { OpenAPIObject } from '@nestjs/swagger'
import { AppModule } from 'src/app.module'
import { ACCESS_COOKIE, buildOpenApiDocument, SECURITY_SCHEMES } from './openapi-document'

/**
 * Security in the API document (owner decision 31.10.2026): every route carries exactly one of
 * four marks — public (`security: []`), the access cookie, the partner token or the internal
 * token — read from its guards, so no route goes undocumented and the document cannot drift
 * from what the request actually goes through. The committed `openapi.json` is this document.
 */
type Operation = { security?: Record<string, string[]>[]; description?: string }
const markOf = (operation: Operation) => {
	const security = operation.security
	if (!security) return 'unmarked'
	if (security.length === 0) return 'public'
	if (security.length !== 1 || Object.keys(security[0]).length !== 1) return 'mixed'
	const scheme = Object.keys(security[0])[0]
	return Object.entries(SECURITY_SCHEMES).find(([, name]) => name === scheme)?.[0] ?? 'unknown'
}

let app: INestApplication
let document: OpenAPIObject
beforeAll(async () => {
	app = await NestFactory.create(AppModule, { logger: false, preview: true })
	document = buildOpenApiDocument(app)
}, 60_000)
afterAll(async () => {
	await app?.close()
})
const operations = () =>
	Object.entries(document.paths).flatMap(([path, item]) =>
		Object.entries(item as Record<string, Operation>).map(([method, operation]) => ({
			key: `${method.toUpperCase()} ${path}`,
			operation
		}))
	)

it('marks every route with exactly one of the four requirements', () => {
	const marks = operations().map(({ key, operation }) => [key, markOf(operation)] as const)
	expect(
		marks.filter(([, mark]) => !['public', 'cookie', 'partner', 'internal'].includes(mark))
	).toEqual([])
	expect(marks.length).toBeGreaterThan(150)
})

it('declares the three schemes, the cookie by its canonical name, as the default', () => {
	expect(document.components?.securitySchemes).toMatchObject({
		[SECURITY_SCHEMES.cookie]: { type: 'apiKey', in: 'cookie', name: ACCESS_COOKIE },
		[SECURITY_SCHEMES.partner]: { type: 'http', scheme: 'bearer' },
		[SECURITY_SCHEMES.internal]: { type: 'apiKey', in: 'header', name: 'x-internal-token' }
	})
	expect(ACCESS_COOKIE).toBe('access_token')
	expect(document.security).toEqual([{ [SECURITY_SCHEMES.cookie]: [] }])
})

it('reads the marks from the guards: public, signed-in, admin with its role, partner', () => {
	const at = (method: string, path: string) =>
		(document.paths[path] as Record<string, Operation>)[method]
	for (const [method, path] of [
		['get', '/categories/tree'],
		['get', '/products/catalog/v2'],
		['get', '/catalog/sitemap'],
		['post', '/orders'],
		['post', '/auth/login']
	])
		expect(markOf(at(method, path))).toBe('public')
	expect(markOf(at('get', '/orders/me'))).toBe('cookie')
	expect(at('get', '/orders/me').description).toMatch(/^Requires sign-in \(access cookie\)\./)
	for (const [method, path] of [
		['get', '/categories/admin/tree'],
		['post', '/categories/drafts'],
		['patch', '/storefront-settings']
	]) {
		expect(markOf(at(method, path))).toBe('cookie')
		expect(at(method, path).description).toMatch(/^Requires role: ADMIN \(access cookie\)\./)
	}
	expect(markOf(at('post', '/partner/v1/categories'))).toBe('partner')
})

it('the committed openapi.json carries the same marks (run yarn spec:export after a change)', () => {
	// Marks only: under ts-jest's isolated compilation Swagger infers some parameters differently
	// from the export (ts-node), which is not what this spec is about.
	const committed = JSON.parse(
		readFileSync(join(__dirname, '../../../openapi.json'), 'utf8')
	) as OpenAPIObject
	const marksOf = (doc: OpenAPIObject) =>
		Object.fromEntries(
			Object.entries(doc.paths).flatMap(([path, item]) =>
				Object.entries(item as Record<string, Operation>).map(([method, operation]) => [
					`${method} ${path}`,
					JSON.stringify(operation.security)
				])
			)
		)
	expect(marksOf(committed)).toEqual(marksOf(document))
	expect(committed.components?.securitySchemes).toEqual(document.components?.securitySchemes)
	expect(committed.security).toEqual(document.security)
})
