/** Persistent local-only v2 workspace; source database is never modified. */
const { mongo } = require('mongoose')
const { randomUUID, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const argon2 = require('argon2')
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true })
const { CatalogWriteGate } = require('../src/database/mongoose/repositories/catalog-write-gate')
const { CategoryTreeWriter } = require('../src/modules/category/category-tree-writer')
async function ensureLogin(db) {
	const file = path.join(__dirname, '../.local/catalog-workspace-login.json')
	const email = 'catalog-admin@fillando.local'
	const existing = await db.collection('users').findOne({ email })
	if (existing && !fs.existsSync(file))
		throw Error('Local login file missing; no password was reset')
	if (existing) {
		if (existing.picture === undefined)
			await db
				.collection('users')
				.updateOne({ _id: existing._id }, { $set: { picture: null } })
		return
	}
	if (!process.env.PASSWORD_PEPPER) throw Error('Local PASSWORD_PEPPER missing')
	fs.mkdirSync(path.dirname(file), { recursive: true })
	if (!fs.existsSync(file))
		fs.writeFileSync(
			file,
			JSON.stringify({ email, password: randomBytes(24).toString('base64url') }, null, 2),
			{ mode: 0o600, flag: 'wx' }
		)
	const credentials = JSON.parse(fs.readFileSync(file, 'utf8'))
	if (credentials.email !== email) throw Error('Unexpected local login file')
	const password = await argon2.hash(credentials.password, {
		secret: Buffer.from(process.env.PASSWORD_PEPPER)
	})
	await db.collection('users').insertOne({
		email,
		password,
		name: 'Локальний каталог',
		picture: null,
		role: 'ADMIN',
		authMethod: 'EMAIL',
		createdAt: new Date(),
		updatedAt: new Date()
	})
	console.log('Local-only admin credentials saved in .local/catalog-workspace-login.json')
}
async function main() {
	const client = new mongo.MongoClient('mongodb://127.0.0.1:27019')
	await client.connect()
	try {
		const source = client.db('fillando-prod'),
			db = client.db('fillando_catalog_local_v2')
		if (await db.collection('local_workspace').findOne({ _id: 'catalog-v2', ready: true })) {
			await ensureLogin(db)
			console.log('Workspace already prepared; existing edits preserved')
			return
		}
		if ((await db.listCollections().toArray()).length)
			throw Error('Target exists without ready marker; inspect it. Nothing deleted.')
		if (!(await source.collection('categories').countDocuments()))
			throw Error('Local source has no categories')
		for (const name of [
			'categories',
			'products',
			'product_variants',
			'vendors',
			'colors',
			'users',
			'refresh_tokens',
			'numbers',
			'settings'
		]) {
			if (!(await source.listCollections({ name }).hasNext())) continue
			await db.createCollection(name)
			let batch = [],
				count = 0
			for await (const row of source.collection(name).find({})) {
				batch.push(row)
				if (batch.length === 100) {
					await db.collection(name).insertMany(batch)
					count += batch.length
					batch = []
				}
			}
			if (batch.length) {
				await db.collection(name).insertMany(batch)
				count += batch.length
			}
			for (const index of await source.collection(name).indexes()) {
				if (index.name === '_id_') continue
				const { key, v, ns, ...options } = index
				await db.collection(name).createIndex(key, options)
			}
			console.log(`${name}: copied ${count}`)
		}
		const gate = new CatalogWriteGate(db)
		await gate.initialize()
		const writer = new CategoryTreeWriter(db)
		const group = new mongo.ObjectId(),
			category = new mongo.ObjectId()
		const field = (key, label, value_type, extra = {}) => ({
			key,
			label,
			value_type,
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
		const definitions = [
			field('current', 'Номінальний струм', 'number', {
				unit: 'А',
				is_required: true,
				filter_type: 'range'
			}),
			field('automatic', 'Автоматичний режим', 'boolean', { order: 1 }),
			field('poles', 'Полюси', 'enum', {
				order: 2,
				options: [{ id: 'four', label: 'Чотири', order: 0 }]
			})
		]
		const categories = [
			{
				id: String(group),
				name: 'Локальний приклад — Електротовари',
				slug: 'local-electrical',
				kind: 'group',
				parent_id: null,
				attribute_definitions: []
			},
			{
				id: String(category),
				name: 'Автомати вводу резерву — приклад',
				slug: 'local-transfer-switches',
				kind: 'product',
				parent_id: String(group),
				attribute_definitions: definitions
			}
		]
		for (const [index, item] of categories.entries())
			await writer.create(
				{
					operationId: randomUUID(),
					ownerId: 'local-workspace-setup',
					expectedRevision: index
				},
				{ ...item, order: 0 }
			)
		const product = new mongo.ObjectId()
		await db.collection('products').insertOne({
			_id: product,
			name: 'Демонстраційний АВР',
			category_id: category,
			variant_axis: { key: 'current' },
			attributes_v2: [
				{ k: 'automatic', v: false },
				{ k: 'poles', v: 'four' }
			],
			attributes: []
		})
		await db.collection('product_variants').insertMany(
			[16, 32, 63].map(value => ({
				_id: new mongo.ObjectId(),
				product_id: product,
				category_id: category,
				name: `Демонстраційний АВР — ${value} А`,
				slug: `local-demo-avr-${value}`,
				sku: `LOCAL-DEMO-${value}`,
				variant_value: value,
				status: 'draft',
				price: 1000,
				stock: 0,
				images: []
			}))
		)
		await db
			.collection('catalog_control')
			.updateOne({ _id: 'catalog' }, { $set: { admin_draft_writes_enabled: true } })
		await ensureLogin(db)
		await db.collection('local_workspace').insertOne({
			_id: 'catalog-v2',
			ready: true,
			source: 'fillando-prod',
			created_at: new Date()
		})
		console.log('Prepared persistent local workspace: fillando_catalog_local_v2')
	} finally {
		await client.close()
	}
}
main().catch(error => {
	console.error(error.message)
	process.exitCode = 1
})
