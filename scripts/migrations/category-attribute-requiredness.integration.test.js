const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { MongoClient, ObjectId } = require('mongoose').mongo
const {
	migrate,
	plan,
	inspect,
	parseArgs,
	VERSION,
	JOURNAL
} = require('./category-attribute-requiredness')

const url = process.env.REQUIREDNESS_TEST_URL
if (
	!url ||
	!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/fillando_test_requiredness(?:\?|$)/.test(url)
) {
	throw new Error(
		'Set REQUIREDNESS_TEST_URL to a disposable loopback database named fillando_test_requiredness'
	)
}
const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 })
const db = client.db(`fillando_test_requiredness_${process.pid}`)
const silent = () => {}
const read = () => db.collection('categories').find({}).sort({ slug: 1 }).toArray()
let original
before(async () => {
	await client.connect()
})
after(async () => {
	await db.dropDatabase()
	await client.close()
})
beforeEach(async () => {
	await db.dropDatabase()
	await db.collection('categories').insertMany([
		{
			_id: new ObjectId(),
			slug: 'filament',
			name: 'Філамент',
			updatedAt: new Date(),
			google_product_category: { id: 499682, path: 'existing' },
			required_attributes: [
				{ key: 'polymer', label: 'Тип пластику', filter_type: 'multi-select', unit: null },
				{
					key: 'reinforcement',
					label: 'Армування',
					filter_type: 'multi-select',
					unit: null
				},
				{ key: 'finish', label: 'Ефект поверхні', filter_type: 'multi-select', unit: null }
			]
		},
		{
			_id: new ObjectId(),
			slug: 'parts',
			name: 'Інша категорія',
			required_attributes: [
				{ key: 'finish', label: 'Покриття', filter_type: 'multi-select', unit: null }
			]
		},
		{ _id: new ObjectId(), slug: 'empty', name: 'Без фільтрів', required_attributes: [] }
	])
	await db
		.collection('products')
		.insertOne({ _id: new ObjectId(), attributes: [{ k: 'finish', v: 'Silk' }] })
	original = await read()
})
const apply = options => migrate(db, { apply: true, ...options }, silent)
const record = () => db.collection(JOURNAL).findOne({ _id: VERSION })
// Inject a transport/write failure while retaining actual MongoDB reads and conditional writes.
function failSecondWrite() {
	let writes = 0
	return {
		databaseName: db.databaseName,
		collection(name) {
			const collection = db.collection(name)
			if (name !== 'categories') return collection
			return new Proxy(collection, {
				get(target, key) {
					if (key === 'updateOne')
						return async (...args) => {
							if (++writes === 2) throw new Error('simulated connection loss')
							return target.updateOne(...args)
						}
					const value = target[key]
					return typeof value === 'function' ? value.bind(target) : value
				}
			})
		}
	}
}

test('dry-run scans all categories and does not even create a journal', async () => {
	const result = await migrate(db, {}, silent)
	assert.deepEqual(result, { categories: 3, fields: 4, required: 2, optional: 2, missing: 0 })
	assert.deepEqual(await read(), original)
	assert.equal(await record(), null)
})
test('apply fills every raw field, preserves the rest, and verifies completion', async () => {
	const products = await db.collection('products').find({}).toArray()
	await apply()
	assert.deepEqual(
		await read(),
		plan(original).map(entry => entry.after)
	)
	assert.deepEqual(await db.collection('products').find({}).toArray(), products)
	assert.equal((await record()).status, 'complete')
	await migrate(db, { verify: true }, silent)
})
test('completed rerun preserves later admin choices', async () => {
	await apply()
	await db
		.collection('categories')
		.updateOne({ slug: 'parts' }, { $set: { 'required_attributes.0.is_required': false } })
	const before = await read()
	await apply()
	assert.deepEqual(await read(), before)
})
test('complete marker cannot hide missing flags', async () => {
	await apply()
	await db
		.collection('categories')
		.updateOne({ slug: 'parts' }, { $unset: { 'required_attributes.0.is_required': '' } })
	await assert.rejects(apply(), /stored boolean/)
	await assert.rejects(migrate(db, { verify: true }, silent), /stored boolean/)
})
test('rejects malformed data before journalling or writing any category', async () => {
	await db
		.collection('categories')
		.updateOne({ slug: 'parts' }, { $set: { 'required_attributes.0.is_required': null } })
	const before = await read()
	await assert.rejects(apply(), /stored boolean/)
	assert.deepEqual(await read(), before)
	assert.equal(await record(), null)
})
test('missing target, duplicate keys and conflicting existing flags are errors', () => {
	const filament = original.find(c => c.slug === 'filament')
	assert.throws(() => plan(original.filter(c => c !== filament)), /exactly one/)
	assert.throws(
		() =>
			plan([{ ...filament, required_attributes: filament.required_attributes.slice(0, 1) }]),
		/missing finish/
	)
	assert.throws(
		() =>
			plan([
				{
					...filament,
					required_attributes: [
						...filament.required_attributes,
						filament.required_attributes[0]
					]
				}
			]),
		/duplicate/
	)
	assert.throws(
		() =>
			plan([
				{
					...filament,
					required_attributes: filament.required_attributes.map(a => ({
						...a,
						is_required: true
					}))
				}
			]),
		/conflicts/
	)
	for (const value of [undefined, null, {}])
		assert.throws(
			() => inspect([{ ...filament, required_attributes: value }]),
			/must be an array/
		)
})
test('write failure is not success; explicit resume completes original saved plan', async () => {
	await assert.rejects(migrate(failSecondWrite(), { apply: true }, silent), /simulated/)
	assert.equal((await record()).status, 'pending')
	await assert.rejects(apply(), /--resume/)
	await apply({ resume: true })
	assert.deepEqual(
		await read(),
		plan(original).map(e => e.after)
	)
	assert.equal((await record()).status, 'complete')
})
test('rollback restores exact original raw documents after partial application', async () => {
	await assert.rejects(migrate(failSecondWrite(), { apply: true }, silent), /simulated/)
	await apply({ rollback: true })
	assert.deepEqual(await read(), original)
	assert.equal((await record()).status, 'rolled_back')
	await apply({ rollback: true })
	assert.deepEqual(await read(), original)
})
test('rollback restores complete migration and can resume its own interrupted writes', async () => {
	await apply()
	await assert.rejects(
		migrate(failSecondWrite(), { apply: true, rollback: true }, silent),
		/simulated/
	)
	assert.equal((await record()).status, 'rolling_back')
	await assert.rejects(apply({ resume: true }), /Rollback is in progress/)
	await apply({ rollback: true })
	assert.deepEqual(await read(), original)
})
test('concurrent edits block resume and rollback before further writes', async () => {
	await assert.rejects(migrate(failSecondWrite(), { apply: true }, silent), /simulated/)
	await db.collection('categories').updateOne({ slug: 'parts' }, { $set: { name: 'Edited' } })
	const before = await read()
	await assert.rejects(apply({ resume: true }), /changed outside/)
	await assert.rejects(apply({ rollback: true }), /changed outside/)
	assert.deepEqual(await read(), before)
})
test('new/deleted categories cannot silently escape the saved plan', async () => {
	await assert.rejects(migrate(failSecondWrite(), { apply: true }, silent), /simulated/)
	await db.collection('categories').insertOne({ slug: 'new', required_attributes: [] })
	await assert.rejects(apply({ resume: true }), /Category set changed/)
})
test('corrupt backup is rejected without changes', async () => {
	await apply()
	await db.collection(JOURNAL).updateOne({ _id: VERSION }, { $set: { checksum: 'bad' } })
	const before = await read()
	await assert.rejects(apply({ rollback: true }), /corrupt/)
	assert.deepEqual(await read(), before)
})
test('CLI rejects ambiguous modes and verify requires a completed journal', async () => {
	for (const args of [
		['--dry-run', '--apply'],
		['--verify', '--apply'],
		['--resume', '--rollback'],
		['--oops']
	])
		assert.throws(() => parseArgs(args))
	await assert.rejects(migrate(db, { verify: true }, silent), /not completed/)
	await assert.rejects(apply({ resume: true }), /No saved plan/)
})
