import { randomUUID } from 'node:crypto'
import mongoose, { mongo } from 'mongoose'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { getConnectionToken } from '@nestjs/mongoose'
import request from 'supertest'
import type { Server } from 'node:http'
import { createRbacApp } from 'src/common/testing/rbac-harness'
import { CatalogMutationJournal } from 'src/database/mongoose/repositories/catalog-mutation-journal'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { TypedProductController, TypedProductService } from './typed-product.controller'

/**
 * Editing a published (active) v2 product — the migrated filament case (owner decisions
 * 2026-10-27): names/description/photos/characteristics editable, a colour axis that stores the
 * dictionary id, status changes and archiving, required characteristics enforced, URLs and SKU
 * codes never touched. A new variant is a draft unless «Активний» is chosen, and a SKU becomes
 * active only when the product is complete (owner, 2026-11-15).
 */
const id = (n: number) => n.toString(16).padStart(24, '0')
const oid = (n: number) => new mongo.ObjectId(id(n))
const db = () => mongoose.connection.db!
let app: INestApplication
const path = `/products/${id(10)}/admin/typed-draft`
const read = async () =>
	(
		await request(app.getHttpServer() as Server)
			.get(path)
			.set('x-test-role', 'ADMIN')
	).body as {
		revision: number
		published: boolean
		color_axis: boolean
		name: string
		attributes_v2: { k: string; v: unknown }[]
		variant_axis: { key: string } | null
		variants: {
			id: string
			variant_value: unknown
			status: string
			name: string
			slug: string
		}[]
	}
async function edit(
	extra: object = {},
	change: (body: Record<string, unknown>) => void = () => {}
) {
	const current = await read()
	const body: Record<string, unknown> = {
		expected_revision: current.revision,
		name: current.name,
		attributes_v2: current.attributes_v2,
		variant_axis: current.variant_axis,
		variants: current.variants.map(row => ({ id: row.id, variant_value: row.variant_value })),
		...extra
	}
	change(body)
	return request(app.getHttpServer() as Server)
		.patch(path)
		.set('Idempotency-Key', randomUUID())
		.set('x-test-role', 'ADMIN')
		.send(body)
}
const variant = (n: number) =>
	db()
		.collection('product_variants')
		.findOne({ _id: oid(n) })

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('typed-product-published')
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
	await db().collection('numbers').insertOne({ sku: 500 })
	await db().collection('product_variants').createIndex({ sku: 1 }, { unique: true })
	await db().collection('product_variants').createIndex({ slug: 1 }, { unique: true })
	await db()
		.collection('colors')
		.insertMany([
			{ _id: oid(70), name_uk: 'Чорний', name_en: 'Black', family: 'black' },
			{ _id: oid(71), name_uk: 'Білий', name_en: 'White', family: 'white' },
			{ _id: oid(72), name_uk: 'Червоний', name_en: 'Red', family: 'red' }
		])
	await db()
		.collection('categories')
		.insertOne({
			_id: oid(1),
			name: 'Філамент',
			slug: 'filament',
			kind: 'product',
			parent_id: null,
			status: 'active',
			order: 0,
			attribute_contract_version: 2,
			attribute_definitions: [
				{
					key: 'polymer',
					label: 'Тип пластику',
					value_type: 'string',
					unit: null,
					is_required: true,
					filter_enabled: true,
					filter_type: 'multi-select',
					visible_in_specs: true,
					order: 0,
					multiple: false,
					semantic: 'generic',
					options: []
				},
				{
					key: 'color',
					label: 'Колір',
					value_type: 'string',
					unit: null,
					// A variation is built on a required characteristic only (owner, 2026-11-06).
					is_required: true,
					filter_enabled: false,
					filter_type: null,
					visible_in_specs: true,
					order: 1,
					multiple: false,
					semantic: 'color',
					options: []
				}
			]
		})
	await db()
		.collection('products')
		.insertOne({
			_id: oid(10),
			name: 'Sunlu PLA',
			category_id: oid(1),
			attributes_v2: [{ k: 'polymer', v: 'PLA' }],
			variant_axis: { key: 'color' },
			description: { html: '<p>PLA</p>', json: {} }
		})
	await db()
		.collection('product_variants')
		.insertMany(
			[
				[20, 70, 'Black', 'black'],
				[21, 71, 'White', 'white']
			].map(([n, color, en, family]) => ({
				_id: oid(n as number),
				product_id: oid(10),
				category_id: oid(1),
				name: `Sunlu PLA — ${en === 'Black' ? 'Чорний (Black)' : 'Білий (White)'}`,
				slug: `sunlu-pla-${family as string}`,
				sku: `FL-0000${n as number}`,
				variant_value: id(color as number),
				color_id: oid(color as number),
				color_family: family,
				v_value: en,
				status: 'active',
				price: 400,
				stock: 3,
				images: ['https://example.com/a.jpg']
			}))
		)
})

it('reads a published colour-axis product and renames it without touching URLs or SKU codes', async () => {
	const before = await read()
	expect(before).toMatchObject({ published: true, color_axis: true })
	expect(before.variants.map(row => row.status)).toEqual(['active', 'active'])
	const response = await edit({ name: 'Sunlu PLA+' })
	expect(response.status).toBe(200)
	expect(await variant(20)).toMatchObject({
		name: 'Sunlu PLA+ — Чорний (Black)',
		slug: 'sunlu-pla-black',
		sku: 'FL-000020',
		status: 'active'
	})
})

it('releases the catalogue when a writer outside the gate changed a target after the plan', async () => {
	const before = await read()
	// Prom sync checks the gate, then writes: the write can land between prepare and execute.
	const spy = jest
		.spyOn(CatalogMutationJournal.prototype, 'execute')
		.mockImplementationOnce(async function (this: CatalogMutationJournal, ...args) {
			await db()
				.collection('product_variants')
				.updateOne({ _id: oid(20) }, { $set: { name: 'Changed outside the gate' } })
			// This one-off implementation is used up before it runs: the call reaches the real one.
			return this.execute(...args)
		})
	try {
		expect((await edit({ name: 'Sunlu PLA+' })).status).toBe(503)
	} finally {
		spy.mockRestore()
	}
	// Nothing was written, so the gate is open again: reads work and the next save succeeds.
	expect(
		await db().collection<{ _id: string }>('catalog_control').findOne({ _id: 'catalog' })
	).toMatchObject({
		phase: 'idle',
		revision: before.revision
	})
	expect(await variant(20)).toMatchObject({ name: 'Changed outside the gate' })
	expect((await edit({ name: 'Sunlu PLA+' })).status).toBe(200)
})

it('recolours a SKU together with the legacy colour fields every reader uses', async () => {
	const response = await edit({}, body => {
		;(body.variants as { id: string; variant_value: unknown }[])[0].variant_value = id(72)
	})
	expect(response.status).toBe(200)
	expect(await variant(20)).toMatchObject({
		variant_value: id(72),
		color_id: oid(72),
		color_family: 'red',
		v_value: 'Red',
		name: 'Sunlu PLA — Червоний (Red)',
		slug: 'sunlu-pla-black'
	})
	const unknown = await edit({}, body => {
		;(body.variants as { id: string; variant_value: unknown }[])[0].variant_value = id(99)
	})
	expect(unknown.status).toBe(400)
	expect((unknown.body as { details: { code: string } }).details.code).toBe('UNKNOWN_COLOR')
})

const refusal = (res: { status: number; body: unknown }) => ({
	status: res.status,
	code: (res.body as { details: { code: string } }).details.code,
	issues: (
		(res.body as { details: { issues?: { code: string; variant_id?: string }[] } }).details
			.issues ?? []
	).map(issue => issue.code)
})

it('adds a variant as a draft by default, with its photos, and active when chosen and complete', async () => {
	const added = await edit({
		variant_action: {
			type: 'add',
			variant_value: id(72),
			price: 410,
			stock: 1,
			weight_g: 1220,
			images: ['https://example.com/red-1.jpg', 'https://example.com/red-2.jpg']
		}
	})
	expect(added.status).toBe(200)
	const created = await db()
		.collection('product_variants')
		.findOne({ product_id: oid(10), color_id: oid(72) })
	expect(created).toMatchObject({
		status: 'draft',
		color_family: 'red',
		v_value: 'Red',
		name: 'Sunlu PLA — Червоний (Red)',
		sku: 'FL-000501',
		weight_g: 1220,
		images: ['https://example.com/red-1.jpg', 'https://example.com/red-2.jpg']
	})
	await db()
		.collection('colors')
		.insertOne({ _id: oid(73), name_uk: 'Синій', name_en: 'Blue', family: 'blue' })
	const blue = { type: 'add', variant_value: id(73), stock: 1, weight_g: null, status: 'active' }
	// Active at once only when complete: a photo and a price above zero.
	expect(refusal(await edit({ variant_action: { ...blue, price: 410 } }))).toEqual({
		status: 409,
		code: 'PRODUCT_NOT_READY',
		issues: ['IMAGE_REQUIRED']
	})
	expect(
		refusal(
			await edit({
				variant_action: { ...blue, price: 0, images: ['https://example.com/blue.jpg'] }
			})
		)
	).toEqual({ status: 409, code: 'PRODUCT_NOT_READY', issues: ['POSITIVE_PRICE_REQUIRED'] })
	expect(
		await db()
			.collection('product_variants')
			.countDocuments({ color_id: oid(73) })
	).toBe(0)
	const live = await edit({
		variant_action: { ...blue, price: 410, images: ['https://example.com/blue.jpg'] }
	})
	expect(live.status).toBe(200)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ color_id: oid(73) })
	).toMatchObject({ status: 'active', images: ['https://example.com/blue.jpg'] })
})

it('turns a SKU active only when the product is complete, and judges nothing but that step', async () => {
	const activate = () =>
		edit({ variant_action: { type: 'status', id: id(21), status: 'active' } })
	// An already-active SKU without a photo — a migrated one — is edited as before.
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(21) }, { $set: { images: [] } })
	const current = ((await read()) as unknown as { details: { variants: { id: string }[] } })
		.details
	expect(
		(
			await edit({
				name: 'Sunlu PLA+',
				details: {
					...current,
					variants: current.variants.map(row =>
						row.id === id(21) ? { ...row, price: 420 } : row
					)
				}
			})
		).status
	).toBe(200)
	expect(await variant(21)).toMatchObject({ status: 'active', price: 420, images: [] })
	// Taken off sale it comes back only with a photo…
	expect(
		(await edit({ variant_action: { type: 'status', id: id(21), status: 'draft' } })).status
	).toBe(200)
	expect(refusal(await activate())).toEqual({
		status: 409,
		code: 'PRODUCT_NOT_READY',
		issues: ['IMAGE_REQUIRED']
	})
	expect(await variant(21)).toMatchObject({ status: 'draft' })
	// …and so does an archived one, which restores to active in a published category.
	expect((await edit({ variant_action: { type: 'archive', id: id(21) } })).status).toBe(200)
	expect(refusal(await edit({ variant_action: { type: 'restore', id: id(21) } }))).toEqual({
		status: 409,
		code: 'PRODUCT_NOT_READY',
		issues: ['IMAGE_REQUIRED']
	})
	// The photo and the status may come in one save, as the variant window sends them.
	const details = ((await read()) as unknown as { details: { variants: { id: string }[] } })
		.details
	const both = await edit({
		details: {
			...details,
			variants: details.variants.map(row =>
				row.id === id(21) ? { ...row, images: ['https://example.com/white.jpg'] } : row
			)
		},
		variant_action: { type: 'restore', id: id(21) }
	})
	expect(both.status).toBe(200)
	expect(await variant(21)).toMatchObject({
		status: 'active',
		images: ['https://example.com/white.jpg']
	})
	// The product's own gaps count too: without a description no SKU goes active.
	expect(
		(await edit({ variant_action: { type: 'status', id: id(21), status: 'draft' } })).status
	).toBe(200)
	await db()
		.collection('products')
		.updateOne({ _id: oid(10) }, { $unset: { description: '' } })
	expect(refusal(await activate())).toEqual({
		status: 409,
		code: 'PRODUCT_NOT_READY',
		issues: ['DESCRIPTION_REQUIRED']
	})
	// A sibling's gap does not: SKU 20 has no photo now, SKU 21 is complete.
	await db()
		.collection('products')
		.updateOne({ _id: oid(10) }, { $set: { description: { html: '<p>PLA</p>', json: {} } } })
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(20) }, { $set: { images: [] } })
	expect((await activate()).status).toBe(200)
})

it('changes status, archives and restores to the published state', async () => {
	expect(
		(await edit({ variant_action: { type: 'status', id: id(21), status: 'draft' } })).status
	).toBe(200)
	expect(await variant(21)).toMatchObject({ status: 'draft' })
	expect(
		(await edit({ variant_action: { type: 'status', id: id(21), status: 'active' } })).status
	).toBe(200)
	expect((await edit({ variant_action: { type: 'archive', id: id(21) } })).status).toBe(200)
	expect(await variant(21)).toMatchObject({ status: 'archived', slug: 'sunlu-pla-white' })
	expect((await edit({ variant_action: { type: 'restore', id: id(21) } })).status).toBe(200)
	expect(await variant(21)).toMatchObject({ status: 'active' })
	const same = await edit({ variant_action: { type: 'status', id: id(21), status: 'active' } })
	expect(same.status).toBe(409)
})

it('keeps required characteristics on a published product', async () => {
	const response = await edit({ attributes_v2: [] })
	expect(response.status).toBe(400)
	expect(
		(await db()
			.collection('products')
			.findOne({ _id: oid(10) }))!.attributes_v2
	).toEqual([{ k: 'polymer', v: 'PLA' }])
})

it('refuses an active variant in a draft category', async () => {
	await db()
		.collection('categories')
		.updateOne({}, { $set: { status: 'draft' } })
	await db()
		.collection('product_variants')
		.updateMany({}, { $set: { status: 'draft' } })
	const response = await edit({
		variant_action: { type: 'status', id: id(21), status: 'active' }
	})
	expect(response.status).toBe(409)
	expect((response.body as { details: { code: string } }).details.code).toBe(
		'VARIANT_STATUS_CONFLICT'
	)
})

it('edits the Prom id and supplier article like the old variant form, and adds one with them', async () => {
	await db()
		.collection('product_variants')
		.updateOne(
			{ _id: oid(20) },
			{ $set: { prom_id: '2647333298', vendor_product_sku: 'NPLA-1' } }
		)
	const current = (
		await request(app.getHttpServer() as Server)
			.get(path)
			.set('x-test-role', 'ADMIN')
	).body as {
		details: {
			token: string
			description: unknown
			variants: { id: string; prom_id: string | null; vendor_product_sku: string | null }[]
		}
	}
	expect(current.details.variants.map(row => [row.prom_id, row.vendor_product_sku])).toEqual([
		['2647333298', 'NPLA-1'],
		[null, null]
	])
	const details = {
		...current.details,
		variants: current.details.variants.map(row => {
			const { prom_id, vendor_product_sku, ...rest } = row as Record<string, unknown>
			void prom_id
			void vendor_product_sku
			return row.id === id(20)
				? { ...rest, prom_id: '', vendor_product_sku: 'NPLA-2' }
				: { ...rest, prom_id: ' 555 ' }
		})
	}
	const saved = await edit({ details })
	expect(saved.status).toBe(200)
	expect(await variant(20)).toMatchObject({ prom_id: null, vendor_product_sku: 'NPLA-2' })
	expect(await variant(21)).toMatchObject({ prom_id: '555' })
	// Omitted fields keep the stored value.
	const again = (await read()) as unknown as { details: typeof details }
	const kept = await edit({
		details: {
			...again.details,
			variants: again.details.variants.map(row => {
				const { prom_id, vendor_product_sku, ...rest } = row as Record<string, unknown>
				void prom_id
				void vendor_product_sku
				return { ...rest, price: 401 }
			})
		}
	})
	expect(kept.status).toBe(200)
	expect(await variant(21)).toMatchObject({ prom_id: '555', price: 401 })
	const added = await edit({
		variant_action: {
			type: 'add',
			variant_value: id(72),
			price: 410,
			stock: 1,
			weight_g: null,
			prom_id: '777',
			vendor_product_sku: 'NPLA-RED'
		}
	})
	expect(added.status).toBe(200)
	expect(
		await db()
			.collection('product_variants')
			.findOne({ color_id: oid(72) })
	).toMatchObject({ prom_id: '777', vendor_product_sku: 'NPLA-RED', status: 'draft' })
	// Without them the old defaults hold: our SKU as the supplier article, no Prom link.
	await db()
		.collection('colors')
		.insertOne({ _id: oid(73), name_uk: 'Синій', name_en: 'Blue', family: 'blue' })
	expect(
		(
			await edit({
				variant_action: {
					type: 'add',
					variant_value: id(73),
					price: 410,
					stock: 1,
					weight_g: null
				}
			})
		).status
	).toBe(200)
	const blue = await db()
		.collection('product_variants')
		.findOne({ color_id: oid(73) })
	expect(blue).toMatchObject({ prom_id: null, vendor_product_sku: blue!.sku as string })
})

it('keeps the stored characteristic order, so an unchanged save leaves the product as it was', async () => {
	// A migrated product stores its characteristics in the legacy order, not the definitions'.
	await db()
		.collection('categories')
		.updateOne(
			{ _id: oid(1) },
			{
				$push: {
					attribute_definitions: {
						key: 'material',
						label: 'Матеріал',
						value_type: 'string',
						unit: null,
						is_required: false,
						filter_enabled: false,
						filter_type: null,
						visible_in_specs: true,
						order: 2,
						multiple: false,
						semantic: 'generic',
						options: []
					}
				} as never
			}
		)
	const stored = [
		{ k: 'material', v: 'PLA' },
		{ k: 'polymer', v: 'PLA' }
	]
	await db()
		.collection('products')
		.updateOne({ _id: oid(10) }, { $set: { attributes_v2: stored } })
	const before = await db()
		.collection('products')
		.findOne({ _id: oid(10) })
	expect((await edit()).status).toBe(200)
	// Byte-for-byte the same document: an unchanged save changes nothing.
	expect(
		await db()
			.collection('products')
			.findOne({ _id: oid(10) })
	).toEqual(before)
	expect(
		(
			await edit({}, body => {
				body.attributes_v2 = [
					{ k: 'polymer', v: 'PETG' },
					{ k: 'material', v: 'PETG' }
				]
			})
		).status
	).toBe(200)
	expect(
		(
			await db()
				.collection('products')
				.findOne({ _id: oid(10) })
		)?.attributes_v2
	).toEqual([
		{ k: 'material', v: 'PETG' },
		{ k: 'polymer', v: 'PETG' }
	])
})

it('sets, keeps and clears a SKU promotion like the old variant form (TD-0012)', async () => {
	type Details = {
		token: string
		description: unknown
		variants: {
			id: string
			promo_percent: number | null
			promo_ends_at: string | null
			[key: string]: unknown
		}[]
	}
	const details = async () => ((await read()) as unknown as { details: Details }).details
	const future = new Date(Date.now() + 7 * 864e5).toISOString()
	const first = await details()
	const set = await edit({
		details: {
			...first,
			variants: first.variants.map(row => ({
				...row,
				promo_percent: 15,
				promo_ends_at: row.id === id(20) ? future : null
			}))
		}
	})
	expect(set.status).toBe(200)
	expect(await variant(20)).toMatchObject({ promo_percent: 15, promo_ends_at: new Date(future) })
	expect(await variant(21)).toMatchObject({ promo_percent: 15 })
	expect((await variant(21))!.promo_ends_at ?? null).toBeNull()
	const supplier = (await read()) as unknown as { variants: { supplier_price: unknown }[] }
	expect(supplier.variants[0]).toHaveProperty('supplier_price')
	// An ended promotion resent unchanged is no change; a new past end date is refused.
	await db()
		.collection('product_variants')
		.updateOne({ _id: oid(20) }, { $set: { promo_ends_at: new Date(Date.now() - 864e5) } })
	const stale = await details()
	expect(
		(
			await edit({
				details: { ...stale, variants: stale.variants.map(row => ({ ...row, price: 777 })) }
			})
		).status
	).toBe(200)
	expect(await variant(20)).toMatchObject({ price: 777, promo_percent: 15 })
	const past = await details()
	const refused = await edit({
		details: {
			...past,
			variants: past.variants.map(row =>
				row.id === id(21)
					? { ...row, promo_ends_at: new Date(Date.now() - 864e5).toISOString() }
					: row
			)
		}
	})
	expect(refused.status).toBe(400)
	expect((refused.body as { details: { code: string } }).details.code).toBe('PROMO_ENDS_IN_PAST')
	// A new percent on the ended promotion drops its stale end date; null clears both.
	const renew = await details()
	expect(
		(
			await edit({
				details: {
					...renew,
					variants: renew.variants.map(row =>
						row.id === id(20)
							? { ...row, promo_percent: 20 }
							: { ...row, promo_percent: null }
					)
				}
			})
		).status
	).toBe(200)
	expect(await variant(20)).toMatchObject({ promo_percent: 20, promo_ends_at: null })
	expect(await variant(21)).toMatchObject({ promo_percent: null })
	expect((await variant(21))!.promo_ends_at ?? null).toBeNull()
})

it('changes the supplier of a published product, as the old product form did', async () => {
	await db()
		.collection('vendors')
		.insertMany([
			{ _id: oid(70), name: 'Kingroon', slug: 'kingroon' },
			{ _id: oid(71), name: 'Sunlu', slug: 'sunlu' }
		])
	await db()
		.collection('products')
		.updateOne({ _id: oid(10) }, { $set: { vendor_id: oid(70) } })
	expect(((await read()) as unknown as { vendor_id: string }).vendor_id).toBe(id(70))
	expect((await edit({ vendor_id: id(71) })).status).toBe(200)
	expect(
		(await db()
			.collection('products')
			.findOne({ _id: oid(10) }))!.vendor_id
	).toEqual(oid(71))
	// Omitted: kept. Unknown: refused before any write.
	expect((await edit({ name: 'Renamed' })).status).toBe(200)
	expect(
		(await db()
			.collection('products')
			.findOne({ _id: oid(10) }))!.vendor_id
	).toEqual(oid(71))
	const unknown = await edit({ vendor_id: id(79) })
	expect(unknown.status).toBe(404)
	expect((unknown.body as { details: { code: string } }).details.code).toBe('VENDOR_NOT_FOUND')
})

describe('archiving and removing never-sold products (the old admin «Видалити», made safe)', () => {
	const remove = async (role = 'ADMIN') =>
		request(app.getHttpServer() as Server)
			.post(`/products/${id(10)}/admin/deletion`)
			.set('Idempotency-Key', randomUUID())
			.set('x-test-role', role)
			.send({ expected_revision: (await read()).revision })
	const code = (response: { body: unknown }) =>
		(response.body as { details: { code: string } }).details.code

	it('archives every SKU at once, then removes the product with its SKUs', async () => {
		const live = await remove()
		expect(live.status).toBe(409)
		expect(code(live)).toBe('PRODUCT_DELETE_REQUIRES_INACTIVE')
		expect((await edit({ variant_action: { type: 'archive_all' } })).status).toBe(200)
		expect((await read()).variants.map(row => row.status)).toEqual(['archived', 'archived'])
		const removed = await remove()
		expect(removed.status).toBe(200)
		expect(
			await db()
				.collection('products')
				.findOne({ _id: oid(10) })
		).toBeNull()
		expect(
			await db()
				.collection('product_variants')
				.countDocuments({ product_id: oid(10) })
		).toBe(0)
	})

	it('refuses to remove what an order, a cart or another product still points at', async () => {
		await edit({ variant_action: { type: 'archive_all' } })
		await db()
			.collection('orders')
			.insertOne({ items: [{ product_id: oid(10), variant_id: oid(21) }] })
		const ordered = await remove()
		expect(ordered.status).toBe(409)
		expect(code(ordered)).toBe('PRODUCT_IN_USE')
		await db().collection('orders').deleteMany({})
		await db()
			.collection('carts')
			.insertOne({ items: [{ variant_id: oid(21) }] })
		expect(code(await remove())).toBe('VARIANT_IN_USE')
		await db().collection('carts').deleteMany({})
		// A curated storefront collection that lists it (Plan-0010 B09): the home page would lose
		// a product the owner chose, so the removal is refused like an order reference.
		await db()
			.collection('storefront_settings')
			.insertOne({ collections: [{ title: 'Хіти', product_ids: [oid(10)] }] })
		const curated = await remove()
		expect(curated.status).toBe(409)
		expect(code(curated)).toBe('PRODUCT_IN_USE')
		expect(
			await db()
				.collection('products')
				.findOne({ _id: oid(10) })
		).not.toBeNull()
	})

	it('removes one inactive, never-sold SKU and keeps the last one', async () => {
		const active = await edit({ variant_action: { type: 'delete', id: id(21) } })
		expect(code(active)).toBe('VARIANT_DELETE_REQUIRES_INACTIVE')
		await edit({ variant_action: { type: 'archive', id: id(21) } })
		const removed = await edit({ variant_action: { type: 'delete', id: id(21) } }, body => {
			body.variants = (body.variants as { id: string }[])
				.filter(row => row.id !== id(21))
				.concat({
					id: id(21),
					variant_value: (body.variants as { id: string; variant_value: unknown }[]).find(
						row => row.id === id(21)
					)!.variant_value
				} as never)
		})
		expect(removed.status).toBe(200)
		expect(await variant(21)).toBeNull()
		expect((await read()).variants.map(row => row.id)).toEqual([id(20)])
		await edit({ variant_action: { type: 'archive', id: id(20) } })
		expect(code(await edit({ variant_action: { type: 'delete', id: id(20) } }))).toBe(
			'PRODUCT_NEEDS_A_VARIANT'
		)
	})
})
