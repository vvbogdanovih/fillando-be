import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { storefrontRevalidation } from 'src/common/services/storefront-revalidation.service'
import { feedRefresh } from 'src/common/services/feed-refresh.signal'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import {
	CategoryDraftPlacementController,
	CategoryDraftPlacementService
} from './category-draft-placement'

/**
 * Editing a published v2 category in the new admin (Plan-0010 F03, release blocker): after the
 * migration the filament is a published v2 category and the legacy admin is closed, so its name
 * and characteristics must stay editable — with refusals measured by the exact per-key usage.
 */
const id = (n: number) => n.toString(16).padStart(24, '0')
const db = () => mongoose.connection.db!
let app: INestApplication
const server = () => app.getHttpServer() as Server
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const category = () =>
	db()
		.collection('categories')
		.findOne({ _id: new mongo.ObjectId(id(1)) })
const definition = <T extends object>(patch: T) => ({
	unit: null,
	is_required: false,
	filter_enabled: true,
	filter_type: 'multi-select',
	visible_in_specs: true,
	multiple: false,
	semantic: 'generic',
	options: [],
	...patch
})
const definitions = [
	definition({
		key: 'polymer',
		label: 'Тип пластику',
		value_type: 'enum',
		is_required: true,
		order: 0,
		options: [
			{ id: 'pla', label: 'PLA', order: 0 },
			{ id: 'petg', label: 'PETG', order: 1 },
			{ id: 'abs', label: 'ABS', order: 2 }
		]
	}),
	definition({
		key: 'vaha',
		label: 'Вага',
		value_type: 'number',
		unit: 'г',
		filter_type: 'range',
		order: 1
	}),
	definition({
		key: 'color',
		label: 'Колір',
		value_type: 'string',
		filter_enabled: false,
		filter_type: null,
		semantic: 'color',
		order: 2
	}),
	definition({
		key: 'unused',
		label: 'Порожня',
		value_type: 'string',
		filter_enabled: false,
		filter_type: null,
		order: 3
	})
]
type Definition = Record<string, unknown> & { key: string; options?: unknown }
const replace = (key: string, patch: object) =>
	(definitions as Definition[]).map(item => (item.key === key ? { ...item, ...patch } : item))
async function save(values: object[], key = randomUUID(), at?: number) {
	return request(server())
		.patch(`/categories/${id(1)}/admin/definitions`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: at ?? (await revision()), definitions: values })
}
async function details(body: object, target = id(1), key = randomUUID()) {
	return request(server())
		.patch(`/categories/${target}/admin/details`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({ expected_revision: await revision(), ...body })
}
const usage = (role = 'ADMIN') => {
	const req = request(server()).get(`/categories/${id(1)}/admin/definition-usage`)
	return role ? req.set('x-test-role', role) : req
}
let revalidate: jest.SpyInstance, feed: jest.SpyInstance

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('category-definitions-published')
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
beforeEach(async () => {
	revalidate = jest.spyOn(storefrontRevalidation, 'revalidate').mockImplementation(() => {})
	feed = jest.spyOn(feedRefresh, 'request').mockImplementation(() => {})
	await mongoose.connection.dropDatabase()
	await new CatalogWriteGate(db()).initialize()
	await db()
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
	const filament = new mongo.ObjectId(id(1))
	await db()
		.collection('categories')
		.insertMany([
			{
				_id: filament,
				name: 'Філамент',
				slug: 'filament',
				parent_id: null,
				kind: 'product',
				status: 'active',
				order: 0,
				image: 'https://cdn.example.com/filament.png',
				attribute_contract_version: 2,
				attribute_definitions: definitions,
				// Stored before the category presentation was retired (2026-11-05): ignored.
				presentation: { spec_order: ['vaha'], hidden_spec_keys: [] }
			},
			{
				_id: new mongo.ObjectId(id(2)),
				name: 'Архів',
				slug: 'archive',
				parent_id: null,
				kind: 'product',
				status: 'archived',
				order: 1,
				attribute_contract_version: 2,
				attribute_definitions: []
			}
		])
	const spool = new mongo.ObjectId(id(10)),
		refill = new mongo.ObjectId(id(11))
	await db()
		.collection('products')
		.insertMany([
			{
				_id: spool,
				name: 'PLA',
				category_id: filament,
				variant_axis: { key: 'color' },
				attributes_v2: [
					{ k: 'polymer', v: 'pla' },
					{ k: 'vaha', v: 1000 }
				]
			},
			{
				_id: refill,
				name: 'PETG refill',
				category_id: filament,
				variant_axis: null,
				attributes_v2: [{ k: 'polymer', v: 'petg' }]
			}
		])
	await db()
		.collection('product_variants')
		.insertMany([
			{ product_id: spool, category_id: filament, variant_value: id(20), status: 'active' },
			{ product_id: spool, category_id: filament, variant_value: id(21), status: 'active' },
			{ product_id: refill, category_id: filament, variant_value: null, status: 'active' }
		])
	await db()
		.collection('landings')
		.insertMany([
			{
				category_id: filament,
				slug: 'pla',
				status: 'active',
				contract_version: 2,
				filters_v2: { attributes: [{ key: 'polymer', values: ['pla'] }] }
			},
			{
				category_id: filament,
				slug: 'black',
				status: 'active',
				contract_version: 2,
				filters_v2: { attributes: [], color_families: ['black'] }
			}
		])
})
afterEach(() => jest.restoreAllMocks())

it('renames a published category and sets its tile image without touching the address', async () => {
	const key = randomUUID()
	const first = await details(
		{ name: 'Філамент для 3D-друку', image: 'https://cdn.example.com/new.png' },
		id(1),
		key
	)
	expect(first.status).toBe(200)
	expect(await category()).toMatchObject({
		name: 'Філамент для 3D-друку',
		slug: 'filament',
		image: 'https://cdn.example.com/new.png',
		status: 'active'
	})
	for (const resource of ['categories', 'products', 'landings'])
		expect(revalidate).toHaveBeenCalledWith(resource, 'category details')
	expect(feed).toHaveBeenCalledWith('category details')
	// Absent image keeps it; null removes it; nothing new is a 409, not a silent revision.
	const kept = await details({ name: 'Філамент' })
	expect(kept.status).toBe(200)
	expect(await category()).toMatchObject({
		name: 'Філамент',
		image: 'https://cdn.example.com/new.png'
	})
	expect((await details({ name: 'Філамент', image: null })).status).toBe(200)
	expect((await category())!.image).toBeNull()
	const before = await revision()
	const same = await details({ name: 'Філамент' })
	expect(same.status).toBe(409)
	expect((same.body as { details: { code: string } }).details.code).toBe(
		'CATEGORY_DETAILS_UNCHANGED'
	)
	expect(await revision()).toBe(before)
	expect((await details({ name: 'Філамент', image: 'not a url' })).status).toBe(400)
	const archived = await details({ name: 'Архів 2' }, id(2))
	expect(archived.status).toBe(409)
	expect((archived.body as { details: { code: string } }).details.code).toBe('CATEGORY_ARCHIVED')
})

it('reports the exact usage of every key and option', async () => {
	expect((await usage('')).status).toBe(401)
	expect((await usage('USER')).status).toBe(403)
	const read = await usage()
	expect(read.status).toBe(200)
	expect(read.headers['cache-control']).toBe('no-store')
	const body = read.body as {
		revision: number
		published: boolean
		products: number
		keys: {
			key: string
			products: number
			variants: number
			landings: number
			pins: number
			missing: number
			options: { id: string; products: number; variants: number; landings: number }[]
		}[]
	}
	expect(body).toMatchObject({ revision: await revision(), published: true, products: 2 })
	const byKey = Object.fromEntries(body.keys.map(item => [item.key, item]))
	expect(byKey.polymer).toMatchObject({
		products: 2,
		variants: 0,
		landings: 1,
		pins: 1,
		missing: 0
	})
	expect(byKey.polymer.options).toEqual([
		{ id: 'pla', products: 1, variants: 0, landings: 1 },
		{ id: 'petg', products: 1, variants: 0, landings: 0 },
		{ id: 'abs', products: 0, variants: 0, landings: 0 }
	])
	expect(byKey.color).toMatchObject({ products: 1, variants: 2, landings: 1, pins: 0 })
	expect(byKey.vaha).toMatchObject({ products: 1, missing: 1 })
	expect(byKey.vaha).not.toHaveProperty('settings')
	expect(byKey.unused).toMatchObject({ products: 0, variants: 0, landings: 0, missing: 2 })
})

it('applies the allowed changes to a published category in place and purges the storefront', async () => {
	const next = [
		{
			...(definitions[0] as Definition),
			label: 'Полімер',
			order: 4,
			visible_in_specs: false,
			options: [
				{ id: 'pla', label: 'PLA+', order: 1 },
				{ id: 'petg', label: 'PETG', order: 0 },
				{ id: 'abs', label: 'ABS', order: 2 },
				{ label: 'ASA', order: 3 }
			]
		},
		{ ...(definitions[1] as Definition), filter_enabled: false, filter_type: null },
		definitions[2],
		definitions[3],
		definition({ label: 'Діаметр', value_type: 'number', unit: 'мм', order: 5 })
	]
	const key = randomUUID(),
		at = await revision()
	const saved = await save(next, key, at)
	expect(saved.status).toBe(200)
	// A replay of the same request answers the stored receipt, without a second write.
	expect((await save(next, key, at)).body).toEqual(saved.body)
	expect(await revision()).toBe(at + 1)
	const stored = (await category())!.attribute_definitions as Definition[]
	expect(stored.map(item => item.key).slice(0, 4)).toEqual(['polymer', 'vaha', 'color', 'unused'])
	expect(stored[0]).toMatchObject({ label: 'Полімер', order: 4, visible_in_specs: false })
	expect((stored[0].options as { id: string; label: string }[]).map(o => o.label)).toEqual([
		'PLA+',
		'PETG',
		'ABS',
		'ASA'
	])
	expect((stored[0].options as { id: string }[])[3].id).toMatch(/^o_[a-f0-9]{32}$/)
	expect(stored[1]).toMatchObject({ unit: 'г', filter_enabled: false })
	expect(stored[4]).toMatchObject({ label: 'Діаметр' })
	expect(stored[4].key).toMatch(/^a_/)
	// A characteristic no product or SKU holds a value of changes its unit freely.
	const recut = stored.map((item, index) => (index === 4 ? { ...item, unit: 'см' } : item))
	expect((await save(recut)).status).toBe(200)
	expect(((await category())!.attribute_definitions as Definition[])[4]).toMatchObject({
		unit: 'см'
	})
	expect((await category())!.status).toBe('active')
	expect(revalidate).toHaveBeenCalledWith('categories', 'category definitions')
	expect(feed).toHaveBeenCalledWith('category definitions')
	// The unused key and the unused option go; the exact usage, not «the category has products».
	const trimmed = stored
		.filter(item => item.key !== 'unused')
		.map(item =>
			item.key === 'polymer'
				? {
						...item,
						options: (item.options as { id: string }[]).filter(o => o.id !== 'abs')
					}
				: item
		)
	expect((await save(trimmed)).status).toBe(200)
	expect(((await category())!.attribute_definitions as Definition[]).length).toBe(4)
})

it('refuses breaking changes with the counts of what they would break, writing nothing', async () => {
	const cases: [object[], object][] = [
		[
			(definitions as Definition[]).filter(item => item.key !== 'polymer'),
			{
				code: 'DEFINITION_IN_USE',
				key: 'polymer',
				label: 'Тип пластику',
				usage: { products: 2, variants: 0, landings: 1 }
			}
		],
		[
			(definitions as Definition[]).filter(item => item.key !== 'color'),
			{ code: 'DEFINITION_IN_USE', usage: { products: 1, variants: 2, landings: 1 } }
		],
		[
			replace('vaha', { value_type: 'string', unit: null, filter_type: 'multi-select' }),
			{ code: 'DEFINITION_TYPE_LOCKED', key: 'vaha' }
		],
		// The unit of a value a product holds (1000 г) is part of that value: «1000 кг» would be
		// a different product. Refused before any write, with the count (owner decision 31.10).
		[
			replace('vaha', { unit: 'кг' }),
			{
				code: 'DEFINITION_UNIT_LOCKED',
				key: 'vaha',
				label: 'Вага',
				usage: { products: 1, variants: 0, landings: 0 }
			}
		],
		[
			replace('polymer', {
				options: (definitions[0].options as { id: string }[]).filter(o => o.id !== 'pla')
			}),
			{
				code: 'OPTION_IN_USE',
				option: { id: 'pla', label: 'PLA' },
				usage: { products: 1, variants: 0, landings: 1 }
			}
		],
		[
			replace('polymer', { filter_enabled: false, filter_type: null }),
			{ code: 'FILTER_PINNED', usage: { landings: 1 } }
		],
		[
			replace('vaha', { is_required: true }),
			{ code: 'REQUIRED_VALUES_MISSING', key: 'vaha', usage: { products: 1 } }
		],
		[
			[
				...definitions,
				definition({
					label: 'Діаметр',
					value_type: 'number',
					is_required: true,
					order: 9,
					filter_type: 'range'
				})
			],
			{ code: 'REQUIRED_VALUES_MISSING', label: 'Діаметр', usage: { products: 2 } }
		]
	]
	const before = await category()
	const stamp = await revision()
	for (const [values, expected] of cases) {
		const refused = await save(values)
		expect(refused.status).toBe(409)
		expect((refused.body as { details: object }).details).toMatchObject(expected)
	}
	expect(await category()).toEqual(before)
	expect(await revision()).toBe(stamp)
	expect((await db().collection('catalog_control').findOne({}))!.phase).toBe('idle')
	expect(revalidate).not.toHaveBeenCalled()
})

it('keeps the draft workflow: a required characteristic may be added to a draft with products', async () => {
	await db()
		.collection('categories')
		.updateOne({ _id: new mongo.ObjectId(id(1)) }, { $set: { status: 'draft' } })
	const added = [
		...definitions,
		definition({
			label: 'Діаметр',
			value_type: 'number',
			is_required: true,
			order: 9,
			filter_type: 'range'
		})
	]
	expect((await save(added)).status).toBe(200)
	expect(revalidate).not.toHaveBeenCalled()
	// The type of a used key stays locked in a draft too.
	const locked = await save(
		replace('vaha', { value_type: 'string', unit: null, filter_type: 'multi-select' }).concat(
			((await category())!.attribute_definitions as Definition[]).slice(4)
		)
	)
	expect(locked.status).toBe(409)
})

it('reorders a published category and moves it only under a public group', async () => {
	await db()
		.collection('categories')
		.insertOne({
			_id: new mongo.ObjectId(id(3)),
			name: 'Група',
			slug: 'group',
			parent_id: null,
			kind: 'group',
			status: 'active',
			order: 2,
			attribute_contract_version: 2,
			attribute_definitions: []
		})
	const place = async (parent_id: string | null, order: number) =>
		request(server())
			.patch(`/categories/${id(1)}/draft-placement`)
			.set('Idempotency-Key', randomUUID())
			.set('x-test-role', 'ADMIN')
			.send({ parent_id, order, expected_revision: await revision() })
	expect((await place(null, 5)).status).toBe(200)
	expect(await category()).toMatchObject({ order: 5, parent_id: null, status: 'active' })
	expect(revalidate).toHaveBeenCalledWith('categories', 'category placement')
	// Into a public group: the branch keeps its visibility, slug and products.
	expect((await place(id(3), 0)).status).toBe(200)
	expect(await category()).toMatchObject({
		parent_id: new mongo.ObjectId(id(3)),
		order: 0,
		status: 'active',
		slug: expect.any(String) as unknown
	})
	await db()
		.collection('categories')
		.insertOne({
			_id: new mongo.ObjectId(id(4)),
			name: 'Чернетка-група',
			slug: 'draft-group',
			parent_id: null,
			kind: 'group',
			status: 'draft',
			order: 3,
			attribute_contract_version: 2,
			attribute_definitions: []
		})
	// Under a draft group it would vanish from the storefront: refused, nothing written.
	const hidden = await place(id(4), 0)
	expect(hidden.status).toBe(409)
	expect(hidden.body).toMatchObject({ details: { code: 'CATEGORY_PARENT_NOT_PUBLIC' } })
	expect((await category())!.parent_id).toEqual(new mongo.ObjectId(id(3)))
	expect((await place(null, 1)).status).toBe(200)
	expect((await category())!.parent_id).toBeNull()
})
