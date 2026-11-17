/**
 * Local-only browser rehearsal of the release (Plan-0010 R01 §5, owner decision 31.10.2026): the
 * whole application — `AppModule`, the module graph that ships — on a disposable database, so the
 * storefront, checkout, Google feed and storefront cache purge run the production code. Only what
 * cannot run locally is replaced:
 * - auth: the `x-test-role` header (`HeaderRoleAuthGuard`); `/auth/me` and `/cart` answer for it,
 *   a request without it is a guest;
 * - email: a recorder — no message can leave the machine (`GET /__e2e/emails`);
 * - rate limits: off (the suite is a single client).
 *
 * Test-only routes under `/__e2e/`: recorded emails; storefront purge requests with a hold switch
 * (the control that the page really is cached); the large-menu switch — 151 one-SKU categories
 * that put the header into its lazy mode (more than `NAV_FULL_LINKS` links) when switched on.
 *
 * Started by fillando-fe `playwright.release.config.ts`; refuses any database but its own.
 */
import { Test } from '@nestjs/testing'
import { ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ThrottlerGuard } from '@nestjs/throttler'
import cookieParser from 'cookie-parser'
import type { Request, Response } from 'express'
import { mongo } from 'mongoose'
import { AppModule } from '../src/app.module'
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard'
import { HeaderRoleAuthGuard, TEST_ROLE_HEADER } from '../src/common/testing/rbac-harness'
import {
	PURGE_OUTBOX,
	storefrontRevalidation,
	StorefrontRevalidationService,
	type StorefrontResource
} from '../src/common/services/storefront-revalidation.service'
import { CatalogWriteGate } from '../src/database/mongoose/repositories/catalog-write-gate'
import { MongooseExceptionFilter } from '../src/database/mongoose/mongoose.filter'
import { EmailService } from '../src/modules/email/email.service'

const DATABASE = 'mongodb://127.0.0.1:27018/fillando-test-release-e2e'
const PORT = 19201
const STOREFRONT = 'http://127.0.0.1:19200'
/** Above `NAV_FULL_LINKS` (150) non-empty categories the header switches to its lazy mode. */
const LARGE_MENU = 151
const LARGE_SKU = /^E2E-LARGE-/

type Recorded = { method: string; args: unknown[]; at: string }

/** Every method of `EmailService` records its call and sends nothing. */
function emailRecorder(emails: Recorded[]) {
	const recorder: Record<string, (...args: unknown[]) => Promise<void>> = {}
	for (const method of Object.getOwnPropertyNames(EmailService.prototype))
		if (method !== 'constructor')
			recorder[method] = (...args: unknown[]) => {
				emails.push({ method, args, at: new Date().toISOString() })
				return Promise.resolve()
			}
	return recorder
}

async function seed(db: mongo.Db) {
	await db.dropDatabase()
	const now = new Date()
	await db.collection('vendors').insertOne({
		_id: new mongo.ObjectId('000000000000000000000010'),
		name: 'Локальний постачальник',
		slug: 'local-supplier',
		createdAt: now,
		updatedAt: now
	})
	await db.collection('numbers').insertOne({ sku: 1000, order: 0, discount_coupon: 0 })
	// The large catalogue: published, but its SKUs are drafts until `/__e2e/large-menu` opens them,
	// so the header stays in its full-tree mode for every other test.
	const category = (fields: object) => ({
		order: 0,
		status: 'active',
		attribute_contract_version: 2,
		attribute_definitions: [],
		required_attributes: [],
		image: null,
		seo: { title: null, description: null, h1: null, intro_html: null, bottom_html: null },
		createdAt: now,
		updatedAt: now,
		...fields
	})
	const root = new mongo.ObjectId()
	const leaves = Array.from({ length: LARGE_MENU }, () => new mongo.ObjectId())
	await db.collection('categories').insertMany([
		category({
			_id: root,
			parent_id: null,
			name: 'Великий каталог',
			slug: 'e2e-large',
			kind: 'group',
			order: 100
		}),
		...leaves.map((_id, index) =>
			category({
				_id,
				parent_id: root,
				name: `Велика категорія ${index + 1}`,
				slug: `e2e-large-${index + 1}`,
				kind: 'product',
				order: index
			})
		)
	])
	const products = leaves.map(category_id => ({
		_id: new mongo.ObjectId(),
		name: `Товар великого каталогу ${category_id.toHexString().slice(-6)}`,
		category_id,
		vendor_id: null,
		description: { html: '<p>Синтетичний товар.</p>', json: {} },
		attributes: [],
		attributes_v2: [],
		variant_axis: null,
		createdAt: now,
		updatedAt: now
	}))
	await db.collection('products').insertMany(products)
	await db.collection('product_variants').insertMany(
		products.map((product, index) => ({
			product_id: product._id,
			category_id: product.category_id,
			name: product.name,
			slug: `e2e-large-sku-${index + 1}`,
			sku: `E2E-LARGE-${index + 1}`,
			price: 100,
			stock: 1,
			images: [],
			status: 'draft',
			variant_value: null,
			createdAt: now,
			updatedAt: now
		}))
	)
	const gate = new CatalogWriteGate(db)
	await gate.initialize()
	await db
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
}

async function main() {
	if (process.env.DATABASE_URL !== DATABASE) throw Error(`Disposable ${DATABASE} only`)
	const client = await new mongo.MongoClient(DATABASE, {
		serverSelectionTimeoutMS: 5000
	}).connect()
	const db = client.db()
	await seed(db)

	const emails: Recorded[] = []
	const purges: { resource: StorefrontResource; trigger: string; at: string }[] = []
	let held: (() => void)[] | null = null
	// The real method (on the prototype — the override below shadows it on the instance).
	const purge = (resource: StorefrontResource, trigger: string): void => {
		StorefrontRevalidationService.prototype.revalidate.call(
			storefrontRevalidation,
			resource,
			trigger
		)
	}
	storefrontRevalidation.revalidate = (resource, trigger) => {
		purges.push({ resource, trigger, at: new Date().toISOString() })
		if (held) held.push(() => purge(resource, trigger))
		else purge(resource, trigger)
	}

	const module = await Test.createTestingModule({ imports: [AppModule] })
		.overrideGuard(JwtAuthGuard)
		.useValue(new HeaderRoleAuthGuard())
		.overrideGuard(ThrottlerGuard)
		.useValue({ canActivate: () => true })
		.overrideProvider(EmailService)
		.useValue(emailRecorder(emails))
		.compile()
	const app = module.createNestApplication<NestExpressApplication>({ logger: ['error'] })
	app.useGlobalFilters(new MongooseExceptionFilter())
	app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
	app.useBodyParser('json', { limit: '10mb' })
	app.use(cookieParser())
	app.enableCors({ origin: STOREFRONT, credentials: true, exposedHeaders: ['Retry-After'] })

	const server = app.getHttpAdapter()
	// Registered before Nest's own routes (they are added on listen), so these answer first.
	server.get('/auth/me', (request: Request, response: Response) => {
		const role = request.header(TEST_ROLE_HEADER)
		if (!role) return response.status(401).json({ message: 'Unauthorized' })
		response.json({
			message: 'OK',
			user: {
				id: 'admin-fixture',
				role,
				name: 'Test admin',
				email: 'admin@example.invalid',
				picture: null
			}
		})
	})
	server.get('/cart', (request: Request, response: Response) => {
		if (!request.header(TEST_ROLE_HEADER))
			return response.status(401).json({ message: 'Unauthorized' })
		response.json({ items: [], removed_items: [] })
	})
	server.get('/__e2e/emails', (_request: Request, response: Response) => response.json(emails))
	// `pending`: purges still owed in the outbox (P12) — a delivery or its echo not yet acknowledged.
	server.get('/__e2e/purges', async (_request: Request, response: Response) =>
		response.json({
			held: held !== null,
			pending: await db.collection(PURGE_OUTBOX).countDocuments(),
			purges
		})
	)
	server.post('/__e2e/purges/hold', (request: Request, response: Response) => {
		const hold = (request.body as { hold?: unknown } | undefined)?.hold === true
		if (hold) held ??= []
		else {
			const release = held ?? []
			held = null
			release.forEach(run => run())
		}
		response.json({ held: held !== null })
	})
	server.post('/__e2e/large-menu', async (request: Request, response: Response) => {
		const on = (request.body as { on?: unknown } | undefined)?.on === true
		const result = await db
			.collection('product_variants')
			.updateMany({ sku: LARGE_SKU }, { $set: { status: on ? 'active' : 'draft' } })
		storefrontRevalidation.revalidate('products', 'e2e large menu')
		storefrontRevalidation.revalidate('categories', 'e2e large menu')
		response.json({ on, changed: result.modifiedCount })
	})

	let closing = false
	const close = async () => {
		if (closing) return
		closing = true
		await app.close()
		await db.dropDatabase()
		await client.close()
		process.exit(0)
	}
	process.on('SIGTERM', () => void close())
	process.on('SIGINT', () => void close())
	await app.listen(PORT, '127.0.0.1')
	console.log(`Release rehearsal API ready on 127.0.0.1:${PORT}; disposable database only`)
}
void main().catch(error => {
	console.error(error)
	process.exit(1)
})
