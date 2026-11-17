#!/usr/bin/env node
// Local rehearsal only. Never loads dotenv or boots application jobs.
require('ts-node').register({ transpileOnly: true })
require('tsconfig-paths/register')
const { MongoClient, BSON } = require('mongodb')
const { createHash, randomUUID } = require('node:crypto')
const { buildCatalogStagingPlan } = require('../src/modules/category/catalog-staging-plan')
const {
	parseDefinitions,
	validateAttributes
} = require('../src/modules/category/attribute-definitions')
const { CatalogWriteGate } = require('../src/database/mongoose/repositories/catalog-write-gate')
const {
	CatalogMutationJournal,
	PLAN_MAX_TARGETS,
	PLAN_MAX_BYTES
} = require('../src/database/mongoose/repositories/catalog-mutation-journal')
const hash = value => createHash('sha256').update(BSON.serialize({ value })).digest('hex')
const internal = new Set([
	'catalog_control',
	'catalog_operations',
	'catalog_mutation_plans',
	'catalog_stage_runs'
])
async function fingerprint(db) {
	const result = {}
	for (const { name } of (await db.listCollections({}, { nameOnly: true }).toArray()).sort(
		(a, b) => a.name.localeCompare(b.name)
	)) {
		if (internal.has(name)) continue
		const projection =
			name === 'categories'
				? {
						parent_id: 0,
						kind: 0,
						attribute_contract_version: 0,
						attribute_definitions: 0
					}
				: name === 'products'
					? { attributes_v2: 0 }
					: undefined
		const digest = createHash('sha256')
		let count = 0
		for await (const row of db.collection(name).find({}, { projection }).sort({ _id: 1 })) {
			digest.update(BSON.serialize(row))
			count++
		}
		result[name] = { count, hash: digest.digest('hex') }
	}
	return result
}
async function verify(db, run, staged) {
	if (hash(await fingerprint(db)) !== hash(run.baseline)) throw Error('LEGACY_DATA_CHANGED')
	if (staged) {
		for await (const category of db.collection('categories').find({})) {
			if (
				category.attribute_contract_version !== 1 ||
				category.parent_id !== null ||
				category.kind !== 'product'
			)
				throw Error('STAGING_CONFIGURATION_MISMATCH')
			const definitions = parseDefinitions(category.attribute_definitions)
			for await (const product of db
				.collection('products')
				.find({ category_id: category._id })) {
				const expected = validateAttributes(
					definitions,
					product.attributes.map(({ k, v }) => ({ k, v }))
				)
				if (hash(expected) !== hash(product.attributes_v2))
					throw Error('STAGING_PRODUCT_MISMATCH')
			}
		}
	}
}
async function main(args) {
	const [command, name, operation, ...flags] = args
	if (
		!['dry-run', 'apply', 'inspect', 'resume', 'rollback'].includes(command) ||
		!/^fillando_rehearsal_work_\d{8}$/.test(name || '')
	)
		throw Error(
			'Usage: catalog-stage.cjs dry-run|apply|inspect|resume|rollback fillando_rehearsal_work_YYYYMMDD operation-id [--writers-stopped]'
		)
	if (!operation || !/^[a-zA-Z0-9_-]{1,100}$/.test(operation))
		throw Error('Explicit operation ID required')
	if (flags.some(flag => flag !== '--writers-stopped')) throw Error('Unknown option')
	if (!['dry-run', 'inspect'].includes(command) && !flags.includes('--writers-stopped'))
		throw Error('Stop all writers and pass --writers-stopped')
	const client = await new MongoClient('mongodb://127.0.0.1:27019', {
		serverSelectionTimeoutMS: 3000
	}).connect()
	try {
		const db = client.db(name),
			gate = new CatalogWriteGate(db),
			journal = new CatalogMutationJournal(db, gate)
		const runs = db.collection('catalog_stage_runs', { writeConcern: { w: 1, j: true } })
		if (command === 'dry-run' || command === 'apply') {
			const categories = await db.collection('categories').find({}).sort({ _id: 1 }).toArray()
			const products = await db.collection('products').find({}).sort({ _id: 1 }).toArray()
			if (!categories.length || !products.length) throw Error('EMPTY_CATALOG')
			const patches = buildCatalogStagingPlan(categories, products)
			if (
				patches.length > PLAN_MAX_TARGETS ||
				BSON.calculateObjectSize({ patches }) > PLAN_MAX_BYTES
			)
				throw Error('STAGING_PLAN_TOO_LARGE')
			if (command === 'dry-run') {
				console.log(
					JSON.stringify({
						mode: 'dry-run',
						database: name,
						categories: categories.length,
						products: products.length,
						targets: patches.length,
						plan_hash: hash(patches)
					})
				)
				return
			}
			const baseline = await fingerprint(db)
			await runs.insertOne({
				_id: operation,
				kind: 'stage',
				baseline,
				plan_hash: hash(patches)
			})
			await gate.initialize()
			const token = await gate.acquire(
				operation,
				hash(patches),
				`cli-${randomUUID()}`,
				(await gate.readStamp()).revision
			)
			await journal.prepare(token, patches)
			await journal.execute(token, 'apply')
			await verify(db, { baseline }, true)
			await gate.publishVerified(token)
			console.log(
				JSON.stringify({
					operation,
					status: 'completed',
					targets: patches.length,
					legacy_fingerprint_unchanged: true
				})
			)
			return
		}
		const run = await runs.findOne({ _id: operation })
		if (!run) throw Error('STAGING_RUN_NOT_FOUND')
		if (command === 'inspect') {
			console.log(
				JSON.stringify({
					operation,
					status: (await gate.operation(operation))?.status,
					inspection: await journal.inspect(operation),
					legacy_fingerprint_unchanged: hash(await fingerprint(db)) === hash(run.baseline)
				})
			)
			return
		}
		const state = await db.collection('catalog_control').findOne({ _id: 'catalog' })
		const receipt = await gate.operation(operation)
		if (state?.operation_id !== operation) {
			if (['completed', 'rolled_back', 'aborted'].includes(receipt?.status)) {
				console.log(
					JSON.stringify({ operation, status: receipt.status, already_finished: true })
				)
				return
			}
			throw Error('OPERATION_NOT_CURRENT')
		}
		if (state.phase === 'published') {
			const token = {
				operationId: operation,
				ownerId: state.owner_id,
				revision: state.revision - (state.publication_outcome === 'completed' ? 1 : 0),
				epoch: state.epoch - 1
			}
			await verify(db, run, state.publication_outcome === 'completed')
			await gate.recoverPublication(token, true)
			console.log(JSON.stringify({ operation, status: 'publication_reconciled' }))
			return
		}
		let previous, next
		if (state.phase === 'recovering') {
			previous = state.recovery_from
			next = await gate.claimRecovery(previous, state.owner_id, true)
		} else {
			previous = {
				operationId: operation,
				ownerId: state.owner_id,
				revision: state.revision,
				epoch: state.epoch
			}
			next = await gate.claimRecovery(previous, `cli-${randomUUID()}`, true)
		}
		await journal.adoptRecovery(previous, next)
		await gate.finishRecovery(previous, next)
		await journal.execute(next, command === 'rollback' ? 'rollback' : 'apply')
		await verify(db, run, command === 'resume')
		if (command === 'rollback') await gate.finishRolledBack(next)
		else await gate.publishVerified(next)
		console.log(
			JSON.stringify({
				operation,
				status: command === 'rollback' ? 'rolled_back' : 'completed',
				legacy_fingerprint_unchanged: true
			})
		)
	} finally {
		await client.close()
	}
}
if (require.main === module)
	main(process.argv.slice(2)).catch(error => {
		console.error(error.message)
		process.exitCode = 1
	})
module.exports = { fingerprint, verify, main }
