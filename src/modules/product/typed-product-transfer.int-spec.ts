import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { TypedProductController, TypedProductService } from './typed-product.controller'

/**
 * Moving a typed product between v2 product categories (Plan-0010 F04): characteristics carried
 * over by key or by label into a copied category, the target's required values, an explicit list
 * of lost values, the variant axis, SKU status in a draft target, and identity that never moves.
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
const category = (n: number, name: string, extra: object) => ({
	_id: oid(n),
	name,
	slug: `category-${n}`,
	kind: 'product',
	parent_id: null,
	status: 'active',
	order: n,
	attribute_contract_version: 2,
	...extra
})
const revision = async () =>
	(await db().collection('catalog_control').findOne({}))!.revision as number
const preview = (target: number) =>
	request(server())
		.get(`/products/${id(10)}/admin/transfer`)
		.query({ target_category_id: id(target) })
		.set('x-test-role', 'ADMIN')
/** The `product_variants` fields the move must keep or change. */
type VariantRow = {
	category_id: mongo.ObjectId
	slug: string
	sku: string
	price: number
	status: string
	name: string
}
type Preview = {
	mapped: { source_key: string; target_key: string; value: unknown }[]
	dropped: { key: string; reason: string }[]
	missing_required: string[]
	axis_problem: string | null
	variants_to_draft: number
	proposal: {
		attributes_v2: { k: string; v: unknown }[]
		variant_axis: { key: string } | null
		variants: { id: string; variant_value: unknown }[]
	}
}
async function transfer(
	target: number,
	change: (body: Record<string, unknown>) => void = () => {},
	key = randomUUID()
) {
	const plan = (await preview(target)).body as Preview
	const body: Record<string, unknown> = {
		expected_revision: await revision(),
		target_category_id: id(target),
		...plan.proposal,
		confirm_dropped: plan.dropped.map(row => row.key)
	}
	change(body)
	return request(server())
		.post(`/products/${id(10)}/admin/transfer`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send(body)
}

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('typed-product-transfer')
	app = await createRbacApp({
		controllers: [TypedProductController],
		providers: [
			TypedProductService,
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
	await mongoose.connection.dropDatabase()
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
			category(1, 'Філамент', {
				attribute_definitions: [
					definition('polymer', 'Тип пластику', { is_required: true }),
					definition('vyrobnyk', 'Виробник'),
					definition('series', 'Серія', {
						value_type: 'enum',
						options: [{ id: 'basic', label: 'Basic', order: 0 }]
					}),
					colourAxis('color')
				]
			}),
			// A copy made in the new admin: new keys and option ids, one extra required value.
			category(2, 'Філамент преміум', {
				attribute_definitions: [
					definition('polymer_2', 'Тип пластику', { is_required: true }),
					definition('series_2', 'серія', {
						value_type: 'enum',
						options: [{ id: 'opt-basic', label: 'Basic', order: 0 }]
					}),
					definition('diameter', 'Діаметр', {
						value_type: 'number',
						unit: 'мм',
						is_required: true
					}),
					colourAxis('colour_2')
				]
			}),
			category(3, 'Філамент чернетка', {
				status: 'draft',
				attribute_definitions: [definition('polymer', 'Тип пластику'), colourAxis('color')]
			}),
			category(4, 'АВР', {
				attribute_definitions: [
					definition('current', 'Струм', {
						value_type: 'number',
						unit: 'А',
						filter_type: 'range'
					})
				]
			}),
			{ ...category(5, 'Група', { attribute_definitions: [] }), kind: 'group' },
			category(6, 'Архів', { status: 'archived', attribute_definitions: [] })
		])
	await db()
		.collection('products')
		.insertOne({
			_id: oid(10),
			name: 'Sunlu PLA',
			category_id: oid(1),
			attributes_v2: [
				{ k: 'vyrobnyk', v: 'Sunlu' },
				{ k: 'polymer', v: 'PLA' },
				{ k: 'series', v: 'basic' }
			],
			variant_axis: { key: 'color' }
		})
	await db()
		.collection('product_variants')
		.insertMany(
			[
				[20, 70, 'Black', 'black', 'Чорний (Black)'],
				[21, 71, 'White', 'white', 'Білий (White)']
			].map(([n, color, en, family, label]) => ({
				_id: oid(n as number),
				product_id: oid(10),
				category_id: oid(1),
				name: `Sunlu PLA — ${label as string}`,
				slug: `sunlu-pla-${family as string}`,
				sku: `FL-0000${n as number}`,
				variant_value: id(color as number),
				color_id: oid(color as number),
				color_family: family,
				v_value: en,
				status: 'active',
				price: 400,
				stock: 3,
				images: []
			}))
		)
})

it('proposes carrying characteristics over by key or label and lists what is lost or missing', async () => {
	const response = await preview(2)
	expect(response.status).toBe(200)
	const plan = response.body as Preview
	expect(plan.mapped).toEqual([
		{
			source_key: 'polymer',
			target_key: 'polymer_2',
			target_label: 'Тип пластику',
			value: 'PLA'
		},
		// Enum option matched by its label, not by the (new) id.
		{ source_key: 'series', target_key: 'series_2', target_label: 'серія', value: 'opt-basic' }
	])
	expect(plan.dropped).toEqual([
		{
			key: 'vyrobnyk',
			label: 'Виробник',
			value: 'Sunlu',
			value_label: 'Sunlu',
			reason: 'no_target'
		}
	])
	expect(plan.missing_required).toEqual(['diameter'])
	expect(plan.axis_problem).toBeNull()
	expect(plan.proposal.variant_axis).toEqual({ key: 'colour_2' })
	expect(plan.variants_to_draft).toBe(0)
	// Read-only: nothing moved.
	expect(
		await db()
			.collection('products')
			.findOne({ _id: oid(10) })
	).toMatchObject({
		category_id: oid(1)
	})
})

it('moves the product and its SKUs in one operation, keeping URLs, SKU codes and prices', async () => {
	const before = await db()
		.collection<VariantRow>('product_variants')
		.find()
		.sort({ _id: 1 })
		.toArray()
	// A published target needs its required value; the lost one must be confirmed exactly.
	expect((await transfer(2)).body).toMatchObject({ details: { code: 'REQUIRED_VALUE' } })
	const withDiameter = (body: Record<string, unknown>) => {
		body.attributes_v2 = [...(body.attributes_v2 as object[]), { k: 'diameter', v: 1.75 }]
	}
	const unconfirmed = await transfer(2, body => {
		withDiameter(body)
		body.confirm_dropped = []
	})
	expect(unconfirmed.status).toBe(409)
	expect(unconfirmed.body).toMatchObject({ details: { code: 'TRANSFER_PLAN_CHANGED' } })
	const start = await revision()
	const key = randomUUID()
	const response = await transfer(2, withDiameter, key)
	expect(response.status).toBe(201)
	expect(response.body).toMatchObject({
		product_id: id(10),
		category_id: id(2),
		revision: start + 1
	})
	expect(
		await db()
			.collection('products')
			.findOne({ _id: oid(10) })
	).toMatchObject({
		category_id: oid(2),
		attributes_v2: [
			{ k: 'polymer_2', v: 'PLA' },
			{ k: 'series_2', v: 'opt-basic' },
			{ k: 'diameter', v: 1.75 }
		],
		variant_axis: { key: 'colour_2' }
	})
	const after = await db()
		.collection<VariantRow>('product_variants')
		.find()
		.sort({ _id: 1 })
		.toArray()
	expect(
		after.map(row => [row.category_id, row.slug, row.sku, row.price, row.status, row.name])
	).toEqual(before.map(row => [oid(2), row.slug, row.sku, row.price, 'active', row.name]))
	// The same key replays the receipt instead of moving again.
	const replay = await request(server())
		.post(`/products/${id(10)}/admin/transfer`)
		.set('Idempotency-Key', key)
		.set('x-test-role', 'ADMIN')
		.send({
			expected_revision: start,
			target_category_id: id(2),
			attributes_v2: [
				{ k: 'polymer_2', v: 'PLA' },
				{ k: 'series_2', v: 'opt-basic' },
				{ k: 'diameter', v: 1.75 }
			],
			variant_axis: { key: 'colour_2' },
			variants: [
				{ id: id(20), variant_value: id(70) },
				{ id: id(21), variant_value: id(71) }
			],
			confirm_dropped: ['vyrobnyk']
		})
	expect(replay.body).toEqual(response.body)
	expect(await revision()).toBe(start + 1)
})

it('turns active SKUs into drafts in a draft category', async () => {
	const plan = (await preview(3)).body as Preview
	expect(plan.variants_to_draft).toBe(2)
	expect(plan.dropped.map(row => row.key).sort()).toEqual(['series', 'vyrobnyk'])
	expect((await transfer(3)).status).toBe(201)
	const variants = await db().collection<VariantRow>('product_variants').find().toArray()
	expect(variants.map(row => [row.category_id, row.status])).toEqual([
		[oid(3), 'draft'],
		[oid(3), 'draft']
	])
})

it('refuses an axis the target cannot hold, the same category and non-product targets', async () => {
	const avr = (await preview(4)).body as Preview
	expect(avr.axis_problem).toBe('AXIS_NO_TARGET')
	const refused = await transfer(4)
	expect(refused.status).toBe(409)
	expect(refused.body).toMatchObject({ details: { code: 'TRANSFER_AXIS_INCOMPATIBLE' } })
	expect((await preview(1)).body).toMatchObject({ details: { code: 'TRANSFER_SAME_CATEGORY' } })
	for (const target of [5, 6])
		expect((await preview(target)).body).toMatchObject({
			details: { code: 'TRANSFER_TARGET_INVALID' }
		})
	expect((await preview(99)).status).toBe(404)
	// Nothing was written, and the gate stays open.
	expect(await db().collection('catalog_control').findOne({})).toMatchObject({ phase: 'idle' })
	expect(
		await db()
			.collection('product_variants')
			.countDocuments({ category_id: oid(1) })
	).toBe(2)
})

it('is ADMIN-only', async () => {
	expect(
		(
			await request(server())
				.get(`/products/${id(10)}/admin/transfer`)
				.query({ target_category_id: id(2) })
				.set('x-test-role', 'USER')
		).status
	).toBe(403)
})
