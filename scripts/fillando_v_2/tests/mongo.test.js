// Opt-in real MongoDB regressions; never reads DATABASE_URL or a dotenv file.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const mongoose = require('mongoose')
const { snapshot, COLLECTIONS } = require('../catalog-snapshot')
const { report } = require('../verify-catalog-state')
const { applyRename, mergeJournal, LONG_PREFIX } = require('../rename-products-short')
const { SHORT_NAMES } = require('../short-names')
const uri = process.env.TEST_MIGRATION_URI

test(
	'real Mongo: complete verifier rejects data damage and rename resumes after an interrupted write',
	{ skip: !uri },
	async () => {
		assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/rehearsal$/)
		const client = new mongoose.mongo.MongoClient(uri)
		await client.connect()
		const name = `migration_safety_${process.pid}_${Date.now()}`
		const db = client.db(name)
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fillando-mongo-safety-'))
		try {
			for (const collection of COLLECTIONS) {
				const docs = await client.db('rehearsal').collection(collection).find({}).toArray()
				if (docs.length) await db.collection(collection).insertMany(docs)
			}
			assert.equal(await report(db, { complete: true }), true)
			const v = await db.collection('product_variants').findOne({ color_id: { $ne: null } })
			await db
				.collection('product_variants')
				.updateOne({ _id: v._id }, { $set: { color_id: new mongoose.Types.ObjectId() } })
			assert.equal(await report(db, { complete: true }), false)
			await db.collection('product_variants').replaceOne({ _id: v._id }, v)
			await db
				.collection('product_variants')
				.updateOne({ _id: v._id }, { $set: { category_id: new mongoose.Types.ObjectId() } })
			assert.equal(await report(db, { complete: true }), false)
			await db.collection('product_variants').replaceOne({ _id: v._id }, v)
			const category = await db.collection('categories').findOne({ slug: 'filament' })
			await db
				.collection('categories')
				.updateOne({ _id: category._id }, { $set: { required_attributes: [] } })
			assert.equal(await report(db, { complete: true }), false)
			await db.collection('categories').replaceOne({ _id: category._id }, category)
			const landing = await db.collection('landings').findOne({})
			await db.collection('landings').updateOne({ _id: landing._id }, { $set: { bottom_html: '<p><br></p>' } })
			assert.equal(await report(db, { complete: true }), false)
			await db.collection('landings').replaceOne({ _id: landing._id }, landing)
			const before = await snapshot(db)
			assert.equal(await report(db, { complete: true }), true)
			assert.equal(await snapshot(db), before, 'verification must not write')

			// A separate synthetic catalogue with a unique slug index, using an actual dictionary name.
			for (const collection of COLLECTIONS) await db.collection(collection).deleteMany({})
			const oldName = Object.keys(SHORT_NAMES).find(n => n.startsWith(LONG_PREFIX))
			const newName = SHORT_NAMES[oldName]
			const productId = new mongoose.Types.ObjectId()
			const variantId = new mongoose.Types.ObjectId()
			const colorId = new mongoose.Types.ObjectId()
			await db.collection('products').insertOne({ _id: productId, name: oldName })
			await db
				.collection('colors')
				.insertOne({ _id: colorId, name_en: 'Black', name_uk: 'Чорний', family: 'black' })
			const { generateSlug } = require('../normalize-variant-colors')
			const oldSlug = generateSlug(`${oldName} Black`)
			const newSlug = generateSlug(`${newName} Black`)
			await db.collection('product_variants').insertOne({
				_id: variantId,
				product_id: productId,
				sku: 'TEST',
				name: `${oldName} — Чорний (Black)`,
				slug: oldSlug,
				v_value: 'Black',
				color_id: colorId
			})
			await db.collection('product_variants').createIndex({ slug: 1 }, { unique: true })
			const entry = {
				product_id: String(productId),
				old_name: oldName,
				new_name: newName,
				variants: [
					{
						_id: variantId,
						sku: 'TEST',
						old_slug: oldSlug,
						new_slug: newSlug,
						old_name: `${oldName} — Чорний (Black)`,
						new_name: `${newName} — Чорний (Black)`,
						parked: false
					}
				]
			}
			const journal = mergeJournal(null, { generated_for: name, renamed: [entry] })
			const journalFile = path.join(root, 'rename-journal.json')
			fs.writeFileSync(journalFile, JSON.stringify(journal))
			const variants = db.collection('product_variants')
			let count = 0
			await assert.rejects(
				() =>
					applyRename(
						{
							updateOne: (...args) => {
								if (++count === 2) throw new Error('injected write interruption')
								return variants.updateOne(...args)
							}
						},
						db.collection('products'),
						entry,
						[],
						[]
					),
				/injected/
			)
			assert.equal(
				(await db.collection('products').findOne({ _id: productId })).name,
				newName
			)
			const env = {
				...process.env,
				DATABASE_URL: uri.replace('/rehearsal', `/${name}`),
				MIGRATION_REPORT_DIR: root
			}
			const run = args => {
				const res = spawnSync(
					process.execPath,
					[path.join(__dirname, '../rename-products-short.js'), ...args],
					{ encoding: 'utf8', env }
				)
				assert.equal(res.status, 0, res.stdout + res.stderr)
			}
			run([])
			const recovered = await variants.findOne({ _id: variantId })
			assert.equal(recovered.slug, newSlug)
			assert.equal(recovered.name, `${newName} — Чорний (Black)`)
			const after = await snapshot(db)
			run([])
			run(['--dry-run'])
			assert.equal(await snapshot(db), after)
			assert.equal(
				JSON.parse(fs.readFileSync(journalFile)).renamed[0].variants[0].old_slug,
				oldSlug
			)
			run(['--rollback', journalFile, '--dry-run'])
			assert.equal(await snapshot(db), after)
			run(['--rollback', journalFile])
			assert.equal((await variants.findOne({ _id: variantId })).slug, oldSlug)
			assert.equal(
				(await db.collection('products').findOne({ _id: productId })).name,
				oldName
			)

			// A colour address occupied outside the colour axis must fail before bulk writes.
			await db
				.collection('products')
				.updateOne(
					{ _id: productId },
					{ $set: { variant_type: { key: 'color', label: 'Колір' } } }
				)
			await variants.updateOne({ _id: variantId }, { $set: { slug: 'legacy-address' } })
			const otherId = new mongoose.Types.ObjectId()
			await db.collection('products').insertOne({ _id: otherId, name: 'Other' })
			await variants.insertOne({
				product_id: otherId,
				sku: 'HOLDER',
				slug: oldSlug,
				name: 'Other'
			})
			const collisionState = await snapshot(db)
			const colorRun = () =>
				spawnSync(
					process.execPath,
					[path.join(__dirname, '../normalize-variant-colors.js')],
					{ encoding: 'utf8', env }
				)
			const collision = colorRun()
			assert.equal(collision.status, 1, collision.stdout + collision.stderr)
			assert.match(collision.stdout + collision.stderr, /slug collision/)
			assert.equal(await snapshot(db), collisionState)
			await variants.deleteOne({ sku: 'HOLDER' })
			const mapPath = path.join(root, 'slug-map.json')
			fs.writeFileSync(mapPath, '{broken')
			const unmoved = await snapshot(db)
			const corruptedMap = colorRun()
			assert.equal(corruptedMap.status, 1)
			assert.match(corruptedMap.stderr, /invalid; recover/)
			assert.equal(await snapshot(db), unmoved)
			assert.equal(fs.readFileSync(mapPath, 'utf8'), '{broken')

			const emptyName = `${name}_empty`
			const emptyRun = spawnSync(
				process.execPath,
				[path.join(__dirname, '../run-all.js'), '--include-colors', '--yes'],
				{
					encoding: 'utf8',
					env: { ...env, DATABASE_URL: uri.replace('/rehearsal', `/${emptyName}`) }
				}
			)
			assert.equal(emptyRun.status, 1)
			assert.match(emptyRun.stderr, /no filament category/)
			assert.equal((await client.db(emptyName).listCollections().toArray()).length, 0)
		} finally {
			await db.dropDatabase()
			await client.close()
			fs.rmSync(root, { recursive: true, force: true })
		}
	}
)
