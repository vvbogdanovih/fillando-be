import mongoose, { Types } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import {
	CatalogSitemapController,
	CatalogSitemapService,
	SITEMAP_PART_LIMIT,
	SITEMAP_PART_PLAN
} from './catalog-sitemap'
import { LegacyCatalogWritePolicy } from './legacy-catalog-write.interceptor'
import { CategoryPublicReadService } from '../category/category-public-read.service'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { PublicCatalogService } from '../product/public-catalog.service'
let app: INestApplication, policy: LegacyCatalogWritePolicy
const category = new Types.ObjectId()
beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('catalog-sitemap')
	const mod = await Test.createTestingModule({
		// The rate limit has its own spec; here every request reads (the probes carry the token).
		imports: [
			ThrottlerModule.forRoot({
				throttlers: [{ ttl: 60_000, limit: 1000 }],
				skipIf: () => true
			})
		],
		controllers: [CatalogSitemapController],
		providers: [
			CatalogSitemapService,
			LegacyCatalogWritePolicy,
			CategoryPublicReadService,
			// Landing counts (P02): the listing's own counter for typed landings, the legacy one.
			{
				provide: PublicCatalogService,
				useFactory: (categories: CategoryPublicReadService) =>
					new PublicCatalogService(mongoose.connection, categories, {} as never),
				inject: [CategoryPublicReadService]
			},
			{
				provide: ProductVariantRepository,
				useFactory: () =>
					new ProductVariantRepository(
						// No background index build: it would race each test's dropped database.
						mongoose.connection.model(
							ProductVariant.name,
							ProductVariantSchema.clone().set('autoIndex', false)
						)
					)
			},
			{ provide: getConnectionToken(), useValue: mongoose.connection }
		]
	}).compile()
	app = mod.createNestApplication({ logger: false })
	// As main.ts: the part query's revision/epoch arrive as strings.
	app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
	await app.init()
	policy = app.get(LegacyCatalogWritePolicy)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
	await app?.close()
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
const http = () => request(app.getHttpServer() as Server)
type Part = { from: string | null; to: string | null; urls: number }
type Index = { revision: number; epoch: number; parts: Part[] }
const index = () => http().get('/catalog/sitemap')
const part = (of: Index, at: Part) =>
	http()
		.get('/catalog/sitemap/part')
		.query({
			revision: of.revision,
			epoch: of.epoch,
			...(at.from === null ? {} : { from: at.from }),
			...(at.to === null ? {} : { to: at.to })
		})
/** The whole export as one document: the index and then each of its parts, as the storefront reads it. */
const get = async () => {
	const head = await index()
	if (head.status !== 200) return head
	const body = head.body as Index
	const parts = await Promise.all(body.parts.map(at => part(body, at)))
	const failed = parts.find(res => res.status !== 200)
	if (failed) return failed
	expect(body.parts).toHaveLength(1)
	return parts[0]
}
async function control(phase = 'idle') {
	await mongoose.connection
		.db!.collection<{ _id: string }>('catalog_control')
		.insertOne({ _id: 'catalog', phase, revision: 2, epoch: 3 } as never)
}
it('exports whitelisted URLs together, excluding draft/archived SKU and draft/orphan landings', async () => {
	await control()
	const date = new Date('2026-10-01T12:00:00Z')
	await mongoose.connection.collection('categories').insertOne({
		_id: category,
		name: 'Electrical',
		slug: 'electrical',
		updatedAt: date,
		private_rule: 'hidden'
	})
	// Every SKU has its product: a landing counts SKUs through it (P02).
	const product = new Types.ObjectId()
	await mongoose.connection
		.collection('products')
		.insertOne({ _id: product, category_id: category, attributes: [] })
	await mongoose.connection.collection('product_variants').insertMany(
		['active', 'draft', 'archived'].map(status => ({
			status,
			category_id: category,
			product_id: product,
			slug: status,
			updatedAt: date,
			cost: 10
		}))
	)
	await mongoose.connection.collection('landings').insertMany([
		{ status: 'active', category_id: category, slug: 'avr', updatedAt: date },
		{ status: 'draft', category_id: category, slug: 'draft' },
		{ status: 'active', category_id: new Types.ObjectId(), slug: 'orphan' }
	])
	const res = await get()
	expect(res.status).toBe(200)
	expect(res.headers['cache-control']).toBe('no-store')
	expect(res.body).toEqual({
		initialized: true,
		revision: 2,
		epoch: 3,
		variants: [{ slug: 'active', updatedAt: date.toISOString() }],
		categories: [{ slug: 'electrical', updatedAt: date.toISOString() }],
		landings: [{ slug: 'avr', category_slug: 'electrical', updatedAt: date.toISOString() }]
	})
})
it('leaves out a published landing whose pins match no active SKU, typed or legacy (P02)', async () => {
	await control()
	const [typed, legacy] = [new Types.ObjectId(), new Types.ObjectId()]
	await mongoose.connection.collection('categories').insertMany([
		{
			_id: typed,
			name: 'Typed',
			slug: 'typed',
			attribute_contract_version: 2,
			attribute_definitions: [
				{
					key: 'material',
					label: 'Матеріал',
					value_type: 'string',
					unit: null,
					is_required: false,
					filter_enabled: true,
					filter_type: 'multi-select',
					visible_in_specs: true,
					order: 0,
					multiple: false,
					semantic: 'generic',
					options: []
				}
			]
		},
		{ _id: legacy, name: 'Legacy', slug: 'legacy' }
	])
	const [plate, pla] = [new Types.ObjectId(), new Types.ObjectId()]
	await mongoose.connection.collection('products').insertMany([
		{ _id: plate, category_id: typed, attributes_v2: [{ k: 'material', v: 'Скло' }] },
		{ _id: pla, category_id: legacy, attributes: [{ k: 'polymer', l: 'Полімер', v: 'PLA' }] }
	])
	await mongoose.connection.collection('product_variants').insertMany([
		{ status: 'active', slug: 'glass-plate', category_id: typed, product_id: plate },
		{ status: 'active', slug: 'pla-black', category_id: legacy, product_id: pla }
	])
	const pins = (values: string[]) => ({
		attributes: [{ key: 'material', values }],
		category_ids: [],
		brand_ids: [],
		color_families: []
	})
	await mongoose.connection.collection('landings').insertMany([
		{
			status: 'active',
			category_id: typed,
			slug: 'glass',
			contract_version: 2,
			filters_v2: pins(['Скло'])
		},
		{
			status: 'active',
			category_id: typed,
			slug: 'steel',
			contract_version: 2,
			filters_v2: pins(['Сталь'])
		},
		{ status: 'active', category_id: legacy, slug: 'pla', filters: { polymer: ['PLA'] } },
		{ status: 'active', category_id: legacy, slug: 'nylon', filters: { polymer: ['Nylon'] } }
	])
	const body = (await get()).body as { landings: { slug: string }[] }
	expect(body.landings.map(row => row.slug).sort()).toEqual(['glass', 'pla'])
})
it('builds the URL set once per catalogue state, again after any write to it (P14)', async () => {
	await control()
	const product = new Types.ObjectId()
	await mongoose.connection.collection('categories').insertOne({
		_id: category,
		name: 'Electrical',
		slug: 'electrical'
	})
	await mongoose.connection
		.collection('products')
		.insertOne({ _id: product, category_id: category, attributes: [] })
	const sku = (slug: string) => ({
		status: 'active',
		category_id: category,
		product_id: product,
		slug
	})
	await mongoose.connection.collection('product_variants').insertOne(sku('first'))
	// `build` is private: Nest's `get` hands the instance over in the shape the spy needs.
	const build = jest.spyOn(
		app.get<CatalogSitemapService, { build: () => Promise<unknown> }>(CatalogSitemapService),
		'build'
	)
	const slugs = async () =>
		((await get()).body as { variants: { slug: string }[] }).variants.map(row => row.slug)
	expect(await slugs()).toEqual(['first'])
	expect(await slugs()).toEqual(['first'])
	// The index and its part, twice: one walk of the SKUs.
	expect(build).toHaveBeenCalledTimes(1)
	// A SKU written without a catalogue revision (a Prom sync, a script): a new set.
	await mongoose.connection.collection('product_variants').insertOne(sku('second'))
	expect(await slugs()).toEqual(['first', 'second'])
	expect(build).toHaveBeenCalledTimes(2)
	// A new revision: a new set.
	await mongoose.connection
		.db!.collection<{ _id: string }>('catalog_control')
		.updateOne({ _id: 'catalog' }, { $inc: { revision: 1 } })
	await slugs()
	expect(build).toHaveBeenCalledTimes(3)
})
it('still exports when the server refuses to list the collections — keeping the set is optional', async () => {
	await control()
	const product = new Types.ObjectId()
	await mongoose.connection
		.collection('categories')
		.insertOne({ _id: category, name: 'Electrical', slug: 'electrical' })
	await mongoose.connection
		.collection('products')
		.insertOne({ _id: product, category_id: category, attributes: [] })
	await mongoose.connection.collection('product_variants').insertOne({
		status: 'active',
		category_id: category,
		product_id: product,
		slug: 'first'
	})
	const service = app.get<CatalogSitemapService, { build: () => Promise<unknown> }>(
		CatalogSitemapService
	)
	const build = jest.spyOn(service, 'build')
	// Atlas in production on 17.11.2026: the command with a `$in` filter was refused.
	jest.spyOn(mongoose.connection.db!, 'listCollections').mockImplementation(() => {
		throw new Error("can't get regex from filter doc not a regex")
	})
	const slugs = async () => {
		const res = await get()
		expect(res.status).toBe(200)
		return (res.body as { variants: { slug: string }[] }).variants.map(row => row.slug)
	}
	expect(await slugs()).toEqual(['first'])
	expect(await slugs()).toEqual(['first'])
	// Nothing is kept without a known state: the index and the part each build, both times.
	expect(build).toHaveBeenCalledTimes(4)
})
it('supports an actually empty legacy catalog without inventing control', async () => {
	const res = await get()
	expect(res.body).toEqual({
		initialized: false,
		revision: 0,
		epoch: 0,
		variants: [],
		categories: [],
		landings: []
	})
})
it('rejects maintenance rather than returning empty arrays', async () => {
	await control('writing')
	const res = await get()
	expect(res.status).toBe(503)
	expect(res.body).not.toHaveProperty('variants')
})
it('discards the entire combined export when epoch changes at the verification boundary', async () => {
	await control()
	const verifier = new LegacyCatalogWritePolicy(mongoose.connection)
	jest.spyOn(policy, 'finishRead').mockImplementationOnce(async stamp => {
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { epoch: 1 } })
		await verifier.finishRead(stamp)
	})
	const res = await get()
	expect(res.status).toBe(503)
	expect(res.body).toMatchObject({ details: { code: 'CATALOG_READ_CHANGED' } })
	expect(res.body).not.toHaveProperty('categories')
})
it('exports only the visible, non-empty v2 tree and keeps landings to v1 categories', async () => {
	await control()
	const ids = Array.from({ length: 6 }, () => new Types.ObjectId())
	const definitions: unknown[] = []
	await mongoose.connection.collection('categories').insertMany([
		{
			_id: ids[0],
			name: 'Root',
			slug: 'root',
			kind: 'group',
			attribute_contract_version: 2,
			attribute_definitions: definitions
		},
		{
			_id: ids[1],
			name: 'Mid',
			slug: 'mid',
			kind: 'group',
			parent_id: ids[0],
			attribute_contract_version: 2,
			attribute_definitions: definitions
		},
		{
			_id: ids[2],
			name: 'Leaf',
			slug: 'leaf',
			parent_id: ids[1],
			attribute_contract_version: 2,
			attribute_definitions: definitions
		},
		{
			_id: ids[3],
			name: 'Empty leaf',
			slug: 'empty-leaf',
			parent_id: ids[1],
			attribute_contract_version: 2,
			attribute_definitions: definitions
		},
		{
			_id: ids[4],
			name: 'Hidden',
			slug: 'hidden',
			kind: 'group',
			status: 'draft',
			attribute_contract_version: 2,
			attribute_definitions: definitions
		},
		{
			_id: ids[5],
			name: 'Hidden leaf',
			slug: 'hidden-leaf',
			parent_id: ids[4],
			attribute_contract_version: 2,
			attribute_definitions: definitions
		}
	])
	await mongoose.connection.collection('product_variants').insertMany([
		{ status: 'active', slug: 'leaf-sku', category_id: ids[2] },
		{ status: 'active', slug: 'hidden-sku', category_id: ids[5] },
		{ status: 'draft', slug: 'draft-sku', category_id: ids[3] }
	])
	await mongoose.connection
		.collection('landings')
		.insertOne({ status: 'active', category_id: ids[2], slug: 'typed-landing' })
	const res = await get()
	expect(res.status).toBe(200)
	const body = res.body as {
		variants: unknown[]
		categories: { slug: string }[]
		landings: unknown[]
	}
	expect(body.variants).toEqual([{ slug: 'leaf-sku' }])
	expect(body.categories.map(row => row.slug)).toEqual(['leaf', 'mid', 'root'])
	expect(body.landings).toEqual([])
})

it('filters by the visible tree without a $in of it: drift, orphans, typed and legacy landings (D06)', async () => {
	await control()
	const ids = Array.from({ length: 5 }, () => new Types.ObjectId())
	const at = new Date('2026-10-01T00:00:00Z')
	await mongoose.connection.collection('categories').insertMany([
		{
			_id: ids[0],
			name: 'Group',
			slug: 'group',
			kind: 'group',
			attribute_contract_version: 2,
			attribute_definitions: []
		},
		{
			_id: ids[1],
			name: 'Typed',
			slug: 'typed',
			parent_id: ids[0],
			attribute_contract_version: 2,
			attribute_definitions: [],
			updatedAt: at
		},
		{ _id: ids[2], name: 'Legacy', slug: 'legacy', updatedAt: at },
		{ _id: ids[3], name: 'Hidden legacy', slug: 'hidden-legacy', status: 'archived' },
		{
			_id: ids[4],
			name: 'Empty',
			slug: 'empty',
			attribute_contract_version: 2,
			attribute_definitions: []
		}
	])
	const [typedProduct, legacyProduct] = [new Types.ObjectId(), new Types.ObjectId()]
	await mongoose.connection.collection('products').insertMany([
		{ _id: typedProduct, category_id: ids[1], attributes_v2: [] },
		{ _id: legacyProduct, category_id: ids[2], attributes: [] }
	])
	await mongoose.connection.collection('product_variants').insertMany([
		{
			status: 'active',
			slug: 'b-typed',
			category_id: ids[1],
			product_id: typedProduct,
			updatedAt: at
		},
		{ status: 'active', slug: 'a-legacy', category_id: ids[2], product_id: legacyProduct },
		// A SKU drifted into a group, one of a hidden category, an orphan, one without a category.
		{ status: 'active', slug: 'c-in-group', category_id: ids[0] },
		{ status: 'active', slug: 'd-hidden', category_id: ids[3] },
		{ status: 'active', slug: 'e-orphan', category_id: new Types.ObjectId() },
		{ status: 'active', slug: 'f-none' }
	])
	await mongoose.connection.collection('landings').insertMany([
		{ status: 'active', category_id: ids[2], slug: 'legacy-landing', updatedAt: at },
		{
			status: 'active',
			category_id: ids[1],
			slug: 'typed-with-pins',
			contract_version: 2,
			filters_v2: { attributes: [] }
		},
		{ status: 'active', category_id: ids[1], slug: 'typed-without-pins', contract_version: 2 },
		{ status: 'active', category_id: ids[1], slug: 'legacy-pins-on-typed' },
		{ status: 'active', category_id: ids[3], slug: 'of-hidden' },
		{ status: 'draft', category_id: ids[2], slug: 'draft' }
	])
	const body = (await get()).body as {
		variants: unknown[]
		categories: unknown[]
		landings: unknown[]
	}
	expect(body.variants).toEqual([
		{ slug: 'a-legacy' },
		{ slug: 'b-typed', updatedAt: at.toISOString() }
	])
	expect(body.categories).toEqual([
		{ slug: 'group' },
		{ slug: 'legacy', updatedAt: at.toISOString() },
		{ slug: 'typed', updatedAt: at.toISOString() }
	])
	expect(body.landings).toEqual([
		{ slug: 'legacy-landing', updatedAt: at.toISOString(), category_slug: 'legacy' },
		{ slug: 'typed-with-pins', category_slug: 'typed' }
	])
})

describe('parts (Plan-0010 B05/F10: more than 50 000 URLs)', () => {
	const plan = { ...SITEMAP_PART_PLAN }
	const limit = { ...SITEMAP_PART_LIMIT }
	afterEach(() => {
		Object.assign(SITEMAP_PART_PLAN, plan)
		Object.assign(SITEMAP_PART_LIMIT, limit)
	})
	const leaf = new Types.ObjectId()
	const fixture = async () => {
		await control()
		await mongoose.connection.collection('categories').insertMany([
			{ _id: category, name: 'Electrical', slug: 'electrical' },
			{ _id: leaf, name: 'Blankets', slug: 'blankets' }
		])
		const products = {
			[String(category)]: new Types.ObjectId(),
			[String(leaf)]: new Types.ObjectId()
		}
		await mongoose.connection.collection('products').insertMany(
			[category, leaf].map(id => ({
				_id: products[String(id)],
				category_id: id,
				attributes: []
			}))
		)
		await mongoose.connection.collection('product_variants').insertMany(
			Array.from({ length: 23 }, (_, n) => ({
				status: n % 7 === 3 ? 'draft' : 'active',
				category_id: n % 2 ? category : leaf,
				product_id: products[String(n % 2 ? category : leaf)],
				slug: `sku-${String(n).padStart(3, '0')}`,
				updatedAt: new Date(Date.UTC(2026, 9, 1 + n))
			}))
		)
		await mongoose.connection.collection('landings').insertMany([
			{ status: 'active', category_id: category, slug: 'avr' },
			{ status: 'active', category_id: leaf, slug: 'warm' }
		])
	}
	it('splits by SKU slug range under the planned size; the parts together are the one export', async () => {
		await fixture()
		const whole = (await get()).body as {
			variants: unknown[]
			categories: unknown[]
			landings: unknown[]
		}
		expect(whole.variants).toHaveLength(20)
		SITEMAP_PART_PLAN.urls = 6
		const head = (await index()).body as Index
		expect(head).toMatchObject({ initialized: true, revision: 2, epoch: 3 })
		// 4 categories/landings + 20 SKUs in parts of ≤ 6 URLs: the first carries the pages.
		expect(head.parts.map(at => at.urls)).toEqual([6, 6, 6, 6])
		expect(head.parts[0].from).toBeNull()
		expect(head.parts.at(-1)!.to).toBeNull()
		for (const [n, at] of head.parts.entries())
			if (n > 0) expect(at.from).toBe(head.parts[n - 1].to)
		const parts = await Promise.all(head.parts.map(at => part(head, at)))
		expect(parts.map(res => res.status)).toEqual([200, 200, 200, 200])
		expect(parts.map(res => res.headers['cache-control'])).toEqual(Array(4).fill('no-store'))
		const bodies = parts.map(res => res.body as typeof whole)
		expect(bodies[0].categories).toEqual(whole.categories)
		expect(bodies[0].landings).toEqual(whole.landings)
		expect(
			bodies.slice(1).every(body => !body.categories.length && !body.landings.length)
		).toBe(true)
		expect(bodies.flatMap(body => body.variants)).toEqual(whole.variants)
		expect(
			bodies.map(body => body.variants.length + body.categories.length + body.landings.length)
		).toEqual(head.parts.map(at => at.urls))
	})
	it('cuts a part by bytes too, keeping each response under the limit', async () => {
		await fixture()
		SITEMAP_PART_PLAN.bytes = 700
		const head = (await index()).body as Index
		expect(head.parts.length).toBeGreaterThan(2)
		for (const at of head.parts) {
			const res = await part(head, at)
			expect(res.status).toBe(200)
			expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(700)
		}
	})
	it('refuses a part of another revision or one that outgrew the limit — re-read the index', async () => {
		await fixture()
		SITEMAP_PART_PLAN.urls = 6
		const head = (await index()).body as Index
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { revision: 1 } })
		const stale = await part(head, head.parts[1])
		expect(stale.status).toBe(409)
		expect(stale.body).toMatchObject({ details: { code: 'SITEMAP_REVISION_CHANGED' } })
		expect(stale.body).not.toHaveProperty('variants')
		const fresh = (await index()).body as Index
		SITEMAP_PART_LIMIT.urls = 5
		const large = await part(fresh, fresh.parts[0])
		expect(large.status).toBe(409)
		expect(large.body).toMatchObject({ details: { code: 'SITEMAP_PART_TOO_LARGE' } })
		expect((await http().get('/catalog/sitemap/part').query({ epoch: 3 })).status).toBe(400)
	})
	it('puts a SKU created between the index and the part read into exactly one part', async () => {
		await fixture()
		SITEMAP_PART_PLAN.urls = 6
		const head = (await index()).body as Index
		await mongoose.connection
			.collection('product_variants')
			.insertOne({ status: 'active', category_id: leaf, slug: 'sku-0105' })
		const slugs = (await Promise.all(head.parts.map(at => part(head, at)))).flatMap(res =>
			(res.body as { variants: { slug: string }[] }).variants.map(row => row.slug)
		)
		expect(slugs.filter(slug => slug === 'sku-0105')).toHaveLength(1)
		expect(new Set(slugs).size).toBe(slugs.length)
	})
})
