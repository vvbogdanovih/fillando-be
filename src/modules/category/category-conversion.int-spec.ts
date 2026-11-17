import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import {
	CategoryDraftPlacementController,
	CategoryDraftPlacementService
} from './category-draft-placement'

/**
 * Product category → group with an explicit distribution (Plan-0010 B02, TD-0013 mutations §5):
 * nothing moves without a complete assignment, nothing is lost silently, and the whole move —
 * category, products, SKUs, landings, their old addresses, collections, target placement — is one
 * journal plan behind the gate. Addresses of the category and products never change.
 */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const definition = (key: string, label: string, extra: object = {}) => ({
	key,
	label,
	value_type: 'string',
	unit: null,
	is_required: false,
	filter_enabled: true,
	filter_type: 'multi-select',
	visible_in_specs: true,
	order: 0,
	multiple: false,
	semantic: 'generic',
	options: [],
	...extra
})
// A variation is built on a required characteristic only (owner, 2026-11-06).
const colourAxis = (key: string) =>
	definition(key, 'Колір', {
		semantic: 'color',
		is_required: true,
		filter_enabled: false,
		filter_type: null
	})
const category = (n: number, name: string, slug: string, extra: object) => ({
	_id: oid(n),
	name,
	slug,
	kind: 'product',
	parent_id: null,
	status: 'active',
	order: n,
	attribute_contract_version: 2,
	...extra
})
const filamentDefinitions = [
	definition('polymer', 'Тип пластику', { is_required: true }),
	definition('vyrobnyk', 'Виробник'),
	colourAxis('color')
]
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const row = (collection: string, n: number) =>
	db()
		.collection(collection)
		.findOne({ _id: oid(n) })
const everything = {
	target_kind: 'group',
	assignments: [
		{ product_id: id(10), target_category_id: id(2) },
		{ product_id: id(11), target_category_id: id(3) }
	],
	landing_assignments: [
		{ landing_id: id(30), target_category_id: id(2) },
		{ landing_id: id(31), target_category_id: id(3) }
	],
	adopt_targets: true
}
/** What the two endpoints answer (a plan, a receipt or a coded refusal), as the tests read it. */
type Answer = {
	status: number
	body: {
		plan_id: string | null
		executable: boolean
		problems: unknown[]
		warnings: unknown[]
		landings: unknown[]
		details: Record<string, unknown>
	}
}
const answer = (res: request.Response): Answer => ({
	status: res.status,
	body: res.body as Answer['body']
})
const plan = async (body: object = everything) =>
	answer(
		await request(server())
			.post(`/categories/${id(1)}/admin/conversion-plan`)
			.set('x-test-role', 'ADMIN')
			.send(body)
	)
const convert = async (planId: string, key = randomUUID(), expected?: number) =>
	answer(
		await request(server())
			.post(`/categories/${id(1)}/admin/conversion`)
			.set('Idempotency-Key', key)
			.set('x-test-role', 'ADMIN')
			.send({
				kind: 'group',
				plan_id: planId,
				expected_revision: expected ?? (await revision())
			})
	)

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('category-conversion')
	app = await createRbacApp({
		controllers: [CategoryDraftPlacementController],
		providers: [
			CategoryDraftPlacementService,
			{ provide: getConnectionToken(), useValue: mongoose.connection },
			{
				provide: APP_PIPE,
				useValue: new ValidationPipe({ whitelist: true, transform: true })
			}
		]
	})
})
afterAll(async () => {
	await app?.close()
	await dropTestDb(mongoose)
})
let revalidate: jest.SpyInstance
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	revalidate = jest.spyOn(storefrontRevalidation, 'revalidate').mockImplementation(() => {})
	await new CatalogWriteGate(db()).initialize()
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
	await db()
		.collection('colors')
		.insertMany([
			{ _id: oid(70), name_uk: 'Чорний', name_en: 'Black', family: 'black' },
			{ _id: oid(71), name_uk: 'Білий', name_en: 'White', family: 'white' }
		])
	await db()
		.collection('categories')
		.insertMany([
			category(1, 'Філамент', 'filament', {
				attribute_definitions: filamentDefinitions,
				presentation: { hidden_spec_keys: ['polymer'] },
				google_product_category: { id: 499682, path: '3D Printer Filament' }
			}),
			// Copied in the new admin: new keys, the same labels.
			category(2, 'PLA', 'pla-filament', {
				attribute_definitions: [
					definition('polymer_2', 'Тип пластику', { is_required: true }),
					definition('vyrobnyk_2', 'Виробник'),
					colourAxis('color_2')
				]
			}),
			category(3, 'PETG', 'petg-filament', {
				status: 'draft',
				attribute_definitions: filamentDefinitions
			}),
			// No «Виробник»: a product moving here would lose it.
			category(4, 'Інше', 'other', {
				attribute_definitions: [definition('polymer', 'Тип пластику'), colourAxis('color')]
			})
		])
	await db()
		.collection('products')
		.insertMany([
			{
				_id: oid(10),
				name: 'Kingroon PLA',
				category_id: oid(1),
				attributes_v2: [
					{ k: 'polymer', v: 'PLA' },
					{ k: 'vyrobnyk', v: 'Kingroon' }
				],
				variant_axis: { key: 'color' }
			},
			{
				_id: oid(11),
				name: 'Kingroon PETG',
				category_id: oid(1),
				attributes_v2: [{ k: 'polymer', v: 'PETG' }],
				variant_axis: { key: 'color' }
			}
		])
	await db()
		.collection('product_variants')
		.insertMany(
			[
				[20, 10, 70, 'Kingroon PLA — Чорний (Black)'],
				[21, 10, 71, 'Kingroon PLA — Білий (White)'],
				[22, 11, 70, 'Kingroon PETG — Чорний (Black)']
			].map(([n, product, colour, name]) => ({
				_id: oid(n as number),
				product_id: oid(product as number),
				category_id: oid(1),
				name,
				slug: `sku-${n}`,
				sku: `FL-${n}`,
				variant_value: id(colour as number),
				color_id: oid(colour as number),
				price: 500,
				stock: 3,
				status: 'active'
			}))
		)
	await db()
		.collection('landings')
		.insertMany([
			{
				_id: oid(30),
				category_id: oid(1),
				slug: 'pla',
				h1: 'PLA',
				status: 'active',
				contract_version: 2,
				filters_v2: {
					attributes: [{ key: 'polymer', values: ['PLA'] }],
					category_ids: [],
					brand_ids: [],
					color_families: []
				}
			},
			{
				_id: oid(31),
				category_id: oid(1),
				slug: 'petg-black',
				h1: 'PETG чорний',
				status: 'draft',
				contract_version: 2,
				filters_v2: {
					attributes: [{ key: 'polymer', values: ['PETG'] }],
					category_ids: [],
					brand_ids: [],
					color_families: ['black']
				}
			}
		])
	await db()
		.collection('storefront_settings')
		.insertOne({
			_id: new mongo.ObjectId('00000000000000000000aa01'),
			collections: [
				{ id: randomUUID(), title: 'PLA', category_id: oid(1), landing_id: oid(30) }
			]
		})
})
afterEach(() => revalidate.mockRestore())

it('reports a plan above the journal limit with the limit, and stores none (P08)', async () => {
	const extra = Array.from({ length: 260 }, (_, n) => 1000 + n)
	await db()
		.collection('products')
		.insertMany(
			extra.map(n => ({
				_id: oid(n),
				name: `Товар ${n}`,
				category_id: oid(1),
				attributes_v2: [{ k: 'polymer', v: 'PLA' }],
				variant_axis: { key: 'color' }
			}))
		)
	await db()
		.collection('product_variants')
		.insertMany(
			extra.map(n => ({
				_id: oid(n + 10000),
				product_id: oid(n),
				category_id: oid(1),
				name: `Товар ${n} — Чорний (Black)`,
				slug: `sku-${n}`,
				sku: `FL-${n}`,
				variant_value: id(70),
				color_id: oid(70),
				price: 500,
				stock: 3,
				status: 'active'
			}))
		)
	const large = await plan({
		...everything,
		assignments: [
			...everything.assignments,
			...extra.map(n => ({ product_id: id(n), target_category_id: id(2) }))
		]
	})
	expect(large.status).toBe(200)
	expect(large.body.plan_id).toBeNull()
	expect(large.body.problems).toContainEqual({
		code: 'CONVERSION_PLAN_TOO_LARGE',
		detail: expect.stringMatching(/^\d+$/) as unknown,
		limit: 500
	})
})
it('refuses a distribution that leaves a product or landing unassigned', async () => {
	const res = await plan({ ...everything, assignments: everything.assignments.slice(0, 1) })
	expect(res.status).toBe(400)
	expect(res.body.details).toMatchObject({
		code: 'CONVERSION_ASSIGNMENTS_INVALID',
		kind: 'products',
		missing: [id(11)]
	})
	const target = await plan({
		...everything,
		assignments: [{ product_id: id(10), target_category_id: id(1) }, everything.assignments[1]]
	})
	expect(target.status).toBe(409)
	expect(target.body.details).toMatchObject({
		code: 'CONVERSION_TARGET_INVALID',
		target_category_id: id(1)
	})
})

it('reports values a target would lose and stores no plan', async () => {
	const res = await plan({
		...everything,
		assignments: [{ product_id: id(10), target_category_id: id(4) }, everything.assignments[1]]
	})
	expect(res.status).toBe(200)
	expect(res.body.plan_id).toBeNull()
	expect(res.body.executable).toBe(false)
	expect(res.body.problems).toContainEqual(
		expect.objectContaining({
			code: 'CONVERSION_PRODUCT_LOSES_VALUES',
			product_id: id(10),
			dropped: [expect.objectContaining({ key: 'vyrobnyk', value_label: 'Kingroon' })]
		})
	)
	expect(await db().collection('catalog_conversion_plans').countDocuments()).toBe(0)
	expect((await row('categories', 1))!.kind).toBe('product')
})

it('turns a published product category into a group in one plan without changing any address', async () => {
	const before = await revision()
	const checked = await plan()
	expect(checked.status).toBe(200)
	expect(checked.body).toMatchObject({
		executable: true,
		counts: {
			products: 2,
			variants: 3,
			landings: 2,
			targets: 2,
			variants_to_draft: 1,
			routes: 1
		}
	})
	expect(checked.body.warnings).toEqual(
		expect.arrayContaining([
			{ code: 'CONVERSION_ACTIVE_SKUS_TO_DRAFT', count: 1 },
			{ code: 'CONVERSION_SETTINGS_NOT_CARRIED', count: 2 }
		])
	)
	expect(checked.body.landings[0]).toMatchObject({
		from_path: '/filament/pla',
		to_path: '/pla-filament/pla'
	})
	const key = randomUUID()
	const res = await convert(checked.body.plan_id as string, key)
	expect(res.status).toBe(200)
	expect(res.body).toEqual({ operation_id: key, revision: before + 1, category_id: id(1) })
	// The category: a group with the same address; definitions, card and Google taxonomy gone.
	const group = await row('categories', 1)
	expect(group).toMatchObject({ kind: 'group', slug: 'filament', attribute_definitions: [] })
	expect(group).not.toHaveProperty('presentation')
	expect(group).not.toHaveProperty('google_product_category')
	expect(await row('categories', 2)).toMatchObject({ parent_id: oid(1), order: 0 })
	expect(await row('categories', 3)).toMatchObject({ parent_id: oid(1), order: 1 })
	// Products carried over by label into the copy's keys; SKUs keep slug, code, price, stock.
	expect(await row('products', 10)).toMatchObject({
		category_id: oid(2),
		attributes_v2: [
			{ k: 'polymer_2', v: 'PLA' },
			{ k: 'vyrobnyk_2', v: 'Kingroon' }
		],
		variant_axis: { key: 'color_2' }
	})
	expect(await row('product_variants', 20)).toMatchObject({
		category_id: oid(2),
		slug: 'sku-20',
		sku: 'FL-20',
		price: 500,
		stock: 3,
		status: 'active'
	})
	// A draft target sells nothing: its SKU waits there as a draft.
	expect(await row('product_variants', 22)).toMatchObject({
		category_id: oid(3),
		status: 'draft'
	})
	// Landings: pins in the target's keys; the published one keeps its old address as an alias.
	expect(await row('landings', 30)).toMatchObject({
		category_id: oid(2),
		slug: 'pla',
		filters_v2: { attributes: [{ key: 'polymer_2', values: ['PLA'] }] }
	})
	expect(await row('landings', 31)).toMatchObject({ category_id: oid(3) })
	expect(await db().collection('catalog_routes').find().toArray()).toEqual([
		expect.objectContaining({
			path: '/filament/pla',
			kind: 'alias',
			entity_type: 'landing',
			entity_id: oid(30)
		})
	])
	const settings = await db().collection('storefront_settings').findOne()
	expect((settings!.collections as unknown[])[0]).toMatchObject({
		category_id: oid(2),
		landing_id: oid(30)
	})
	expect(revalidate).toHaveBeenCalledWith('categories', 'category conversion')
	expect(await db().collection('catalog_conversion_plans').countDocuments()).toBe(0)
	// The same key replays the receipt; the used plan cannot run again.
	expect((await convert(checked.body.plan_id as string, key, before)).body).toEqual(res.body)
	expect((await convert(checked.body.plan_id as string)).status).toBe(404)
})

it('refuses a stale or changed plan and leaves the catalogue open', async () => {
	const first = await plan()
	const planId = first.body.plan_id as string
	const before = await revision()
	// A write nobody planned for (an uncooperative raw update) changes what product 10 would carry
	// into the copy's keys: the stored plan no longer describes the writes.
	await db()
		.collection('products')
		.updateOne(
			{ _id: oid(10) },
			{
				$set: {
					attributes_v2: [
						{ k: 'polymer', v: 'PLA+' },
						{ k: 'vyrobnyk', v: 'Kingroon' }
					]
				}
			}
		)
	const changed = await convert(planId)
	expect(changed.status).toBe(409)
	expect(changed.body.details.code).toBe('CONVERSION_PLAN_CHANGED')
	expect(await db().collection('catalog_control').findOne()).toMatchObject({
		phase: 'idle',
		revision: before
	})
	expect((await row('categories', 1))!.kind).toBe('product')
	// A newer revision: the plan is for the revision it was checked on.
	const fresh = (await plan()).body.plan_id as string
	await request(server())
		.patch(`/categories/${id(2)}/admin/details`)
		.set('Idempotency-Key', randomUUID())
		.set('x-test-role', 'ADMIN')
		.send({ name: 'PLA пластик', expected_revision: before })
		.expect(200)
	expect((await convert(fresh)).body.details.code).toBe('CONVERSION_PLAN_STALE')
	expect((await convert(fresh, randomUUID(), before)).body.details.code).toBe(
		'CATEGORY_REVISION_CONFLICT'
	)
	expect((await db().collection('catalog_control').findOne())!.phase).toBe('idle')
})

it('keeps a published target out of a draft group', async () => {
	await db()
		.collection('categories')
		.updateOne({ _id: oid(1) }, { $set: { status: 'draft' } })
	await db()
		.collection('product_variants')
		.updateMany({}, { $set: { status: 'draft' } })
	const res = await plan()
	expect(res.body.plan_id).toBeNull()
	expect(res.body.problems).toContainEqual({
		code: 'CATEGORY_PARENT_NOT_PUBLIC',
		target_category_id: id(2)
	})
	expect((await plan({ ...everything, adopt_targets: false })).body.executable).toBe(true)
})
