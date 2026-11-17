#!/usr/bin/env node
// Moves one flat v1 product category to the v2 contract in place (Plan-0010 B04) through the
// catalogue writer gate and journal. Stop every writer (API, cron, Prom sync) before apply.
// The database is the backend's DATABASE_URL (environment, else fillando-be/.env) and must be the one
// named in the command (`catalog-cli-target.cjs`); no app jobs run here. A loopback server is a local
// run; a remote one needs `--production` (D08 §2): database `fillando-prod`, a typed confirmation for
// every write and a manifest of a restore-checked backup of the live catalogue.
const { MongoClient, BSON } = require('mongodb')
const { createHash, randomUUID } = require('node:crypto')
const { readFileSync, writeFileSync, statSync } = require('node:fs')
const path = require('node:path')
const target = require('./catalog-cli-target.cjs')

const hash = value => createHash('sha256').update(BSON.serialize({ value })).digest('hex')
/**
 * Fields the migration writes; everything else in these collections must stay identical. `name`
 * gains the mapping's `product_name_addition` (owner, 2026-11-05) — checked by `verifyMigrated`
 * instead.
 */
const V2_FIELDS = {
	categories: [
		'kind',
		'parent_id',
		'status',
		'attribute_contract_version',
		'attribute_definitions'
	],
	products: ['attributes_v2', 'variant_axis', 'brand_id', 'purchase_notice', 'name'],
	// The colour fields too: `single_sku_color_key` fills them on SKUs that had none (the plan
	// refuses to overwrite a set one).
	product_variants: ['variant_value', 'name', 'color_id', 'color_family', 'v_value'],
	landings: ['filters_v2', 'contract_version'],
	colors: []
}

async function fingerprint(db, categoryId) {
	const result = {}
	for (const [name, fields] of Object.entries(V2_FIELDS)) {
		const filter =
			name === 'categories'
				? { _id: categoryId }
				: name === 'colors'
					? {}
					: { category_id: categoryId }
		const projection = Object.fromEntries(fields.map(field => [field, 0]))
		const digest = createHash('sha256')
		let count = 0
		for await (const row of db.collection(name).find(filter, { projection }).sort({ _id: 1 })) {
			digest.update(BSON.serialize(row))
			count++
		}
		result[name] = { count, hash: digest.digest('hex') }
	}
	return result
}

/**
 * Domain invariants after apply: definitions parse, every product validates, axis = colour id,
 * and with a name addition every product name carries it and every SKU name starts with its
 * product's name.
 */
async function verifyMigrated(db, categoryId, requireBrand, addition = null) {
	const { readCategoryConfiguration } = require('../src/modules/category/category-configuration')
	const { validateAttributes } = require('../src/modules/category/attribute-definitions')
	const category = await db.collection('categories').findOne({ _id: categoryId })
	const config = readCategoryConfiguration({ ...category, parent_id: null })
	if (config.attribute_contract_version !== 2 || config.status !== 'active')
		throw Error('MIGRATED_CATEGORY_INVALID')
	const variants = await db
		.collection('product_variants')
		.find({ category_id: categoryId })
		.toArray()
	for await (const product of db.collection('products').find({ category_id: categoryId })) {
		const axisKey = product.variant_axis?.key
		validateAttributes(config.attribute_definitions, product.attributes_v2, {
			active: true,
			axisKey
		})
		if (requireBrand && !product.brand_id) throw Error(`BRAND_MISSING:${product._id}`)
		if (addition && !String(product.name).includes(addition))
			throw Error(`NAME_ADDITION_MISSING:${product._id}`)
		for (const variant of variants.filter(row => row.product_id.equals(product._id))) {
			if (addition && !String(variant.name).startsWith(String(product.name)))
				throw Error(`VARIANT_NAME_MISMATCH:${variant._id}`)
			if (
				axisKey
					? variant.variant_value !== String(variant.color_id)
					: variant.variant_value !== null
			)
				throw Error(`VARIANT_VALUE_MISMATCH:${variant._id}`)
		}
	}
}

/** Targets whose current fields do not match the given image of the plan (operator report). */
async function differingTargets(db, patches, side) {
	const { isDeepStrictEqual } = require('node:util')
	const { ObjectId } = require('mongodb')
	const found = []
	for (const patch of patches) {
		const document = await db
			.collection(patch.collection)
			.findOne({ _id: new ObjectId(patch.id) })
		const fields = Object.entries(patch.fields)
			.filter(([key, images]) =>
				images[side].exists
					? !document || !isDeepStrictEqual(document[key], images[side].value)
					: Boolean(document && Object.hasOwn(document, key))
			)
			.map(([key]) => key)
		if (fields.length) found.push(`${patch.collection}:${patch.id}:${fields.join('+')}`)
	}
	return found
}

/**
 * The plan was refused before any write (a target changed since the plan was built, too large,
 * …): release the gate as the HTTP writers do (`abortBeforeWrites`), so a refusal never leaves the
 * catalogue closed (`phase: writing`) waiting for a recovery that has nothing to recover.
 */
async function prepareOrRelease(db, gate, journal, token, patches) {
	try {
		await journal.prepare(token, patches)
	} catch (error) {
		await gate.abortBeforeWrites(token)
		const changed =
			error.code === 'RECOVERY_CONFLICT' ? await differingTargets(db, patches, 'before') : []
		throw Error(
			`${error.code ?? error.message}: nothing was written and the catalogue gate is released` +
				(changed.length
					? `; ${changed.length} target(s) changed since the plan was built: ${changed.slice(0, 10).join(', ')}`
					: '')
		)
	}
}

const COMMANDS = ['dry-run', 'apply', 'inspect', 'resume', 'rollback', 'backup-manifest']
const WRITES = ['apply', 'resume', 'rollback']
const USAGE = `Usage:
  catalog-v2-migrate.cjs dry-run|inspect <database> <operation-id> [--mapping=path] [--production]
  catalog-v2-migrate.cjs apply|resume|rollback <database> <operation-id> --writers-stopped [--mapping=path]
      [--production --confirm=<command>:fillando-prod:<operation-id> --backup-manifest=path]
  catalog-v2-migrate.cjs backup-manifest fillando_release_check_YYYYMMDD --archive=path [--out=path]`

/** Validates the whole invocation before anything connects or loads application code. */
function parseInvocation(
	args,
	env = process.env,
	envFiles = target.readEnvFiles(path.join(__dirname, '..'))
) {
	const [command, name, operation, ...rest] = args
	if (!COMMANDS.includes(command)) throw Error(USAGE)
	if (command === 'backup-manifest') {
		const flags = args.slice(2)
		if (!target.RESTORE_CHECK_DATABASES.test(name || ''))
			throw Error(
				'backup-manifest reads only a local restore check: fillando_release_check_YYYYMMDD'
			)
		const archive = flags.find(flag => flag.startsWith('--archive='))?.slice(10)
		const out = flags.find(flag => flag.startsWith('--out='))?.slice(6)
		if (!archive || flags.some(flag => !/^--(archive|out)=/.test(flag))) throw Error(USAGE)
		return { command, name, archive: path.resolve(archive), out: out && path.resolve(out) }
	}
	if (!operation || !/^[a-zA-Z0-9_-]{1,100}$/.test(operation))
		throw Error('Explicit operation ID required')
	const known = /^--(writers-stopped|production|mapping=.+|confirm=.+|backup-manifest=.+)$/
	if (rest.some(flag => !known.test(flag))) throw Error('Unknown option')
	const production = rest.includes('--production')
	const where = target.resolveTarget({ database: name, production, env, envFiles })
	if (WRITES.includes(command) && !rest.includes('--writers-stopped'))
		throw Error('Stop all writers and pass --writers-stopped')
	if (!production && rest.some(flag => /^--(confirm|backup-manifest)=/.test(flag)))
		throw Error('--confirm and --backup-manifest belong to --production')
	if (WRITES.includes(command))
		target.requireConfirmation(where, rest, [command, name, operation])
	const backupManifest = rest.find(flag => flag.startsWith('--backup-manifest='))?.slice(18)
	if (production && WRITES.includes(command) && !backupManifest)
		throw Error('Production writes need --backup-manifest=<path> of a restore-checked backup')
	const mapping = rest.find(flag => flag.startsWith('--mapping='))?.slice(10)
	return {
		command,
		name,
		operation,
		target: where,
		backupManifest: backupManifest && path.resolve(backupManifest),
		mapping: mapping
			? path.resolve(mapping)
			: path.join(__dirname, 'catalog-v2-migration.filament.json')
	}
}

/** backup-manifest: records a restore-checked backup the production migration will require. */
async function writeBackupManifest({ name, archive, out }) {
	const client = await new MongoClient('mongodb://127.0.0.1:27019', {
		serverSelectionTimeoutMS: 3000
	}).connect()
	try {
		const db = client.db(name)
		const collections = (await db.listCollections().toArray()).map(row => row.name).sort()
		if (!collections.includes('categories') || !collections.includes('product_variants'))
			throw Error('Restore check database has no catalogue; restore the archive first')
		const counts = {}
		for (const collection of collections)
			counts[collection] = await db.collection(collection).countDocuments()
		const manifest = {
			kind: target.MANIFEST_KIND,
			version: 1,
			source_database: target.PRODUCTION_DATABASE,
			archive_path: archive,
			archive_name: path.basename(archive),
			archive_bytes: statSync(archive).size,
			archive_sha256: await target.sha256File(archive),
			restored_database: name,
			checked_at: new Date().toISOString(),
			document_counts: counts,
			catalog: await target.catalogSnapshot(db, BSON)
		}
		const file = out ?? `${archive}.manifest.json`
		writeFileSync(file, JSON.stringify(manifest, null, 1), { mode: 0o600, flag: 'wx' })
		console.log(
			JSON.stringify({
				manifest: file,
				archive_sha256: manifest.archive_sha256,
				catalog: Object.fromEntries(
					Object.entries(manifest.catalog).map(([key, value]) => [key, value.count])
				),
				documents: Object.values(counts).reduce((sum, value) => sum + value, 0)
			})
		)
	} finally {
		await client.close()
	}
}

async function main(args) {
	const invocation = parseInvocation(args)
	if (invocation.command === 'backup-manifest') return writeBackupManifest(invocation)
	const { command, name, operation, target: where } = invocation
	// Application code is loaded only for a valid invocation.
	require('ts-node').register({ transpileOnly: true })
	require('tsconfig-paths/register')
	const {
		buildV2MigrationPlan,
		migrationMappingSchema
	} = require('../src/modules/category/catalog-v2-migration')
	const { CatalogWriteGate } = require('../src/database/mongoose/repositories/catalog-write-gate')
	const {
		CatalogMutationJournal,
		PLAN_MAX_BYTES,
		PLAN_MAX_TARGETS
	} = require('../src/database/mongoose/repositories/catalog-mutation-journal')
	const raw = JSON.parse(readFileSync(invocation.mapping, 'utf8'))
	const { brands: brandSlugs = {}, ...mappingInput } = raw
	const mapping = migrationMappingSchema.parse(mappingInput)
	if (where.mode === 'production')
		console.error(
			JSON.stringify({
				target: target.describeTarget(where),
				command,
				operation,
				mapping: path.basename(invocation.mapping),
				mapping_sha256: createHash('sha256')
					.update(readFileSync(invocation.mapping))
					.digest('hex')
			})
		)
	const client = await new MongoClient(where.uri, {
		serverSelectionTimeoutMS: where.mode === 'production' ? 15000 : 3000,
		// The checks read what was just written (`w: 1`): on a replica set never from a secondary,
		// whatever the URI asks for.
		readPreference: 'primary',
		appName: 'fillando-catalog-v2-migrate'
	}).connect()
	try {
		const db = client.db(name)
		const gate = new CatalogWriteGate(db)
		const journal = new CatalogMutationJournal(db, gate, 'migration')
		const runs = db.collection('catalog_stage_runs', { writeConcern: { w: 1, j: true } })
		const category = await db.collection('categories').findOne({ slug: mapping.category_slug })
		if (!category) throw Error('CATEGORY_NOT_FOUND')

		// Production: the backup must be restore-checked, recent and reproduce the live catalogue
		// exactly — before anything (brands included) is written. A difference means a writer is
		// still running or the manifest belongs to another backup.
		let backup
		if (where.mode === 'production' && command === 'apply') {
			const manifest = await target.verifyBackupManifest(invocation.backupManifest, {
				maxAgeHours: target.MANIFEST_MAX_AGE_HOURS
			})
			const differences = target.snapshotDifferences(
				manifest.catalog,
				await target.catalogSnapshot(db, BSON)
			)
			if (differences.length)
				throw Error(
					`BACKUP_DOES_NOT_MATCH_CATALOG: ${differences.join(', ')} changed after the backup (writers not stopped?) or the manifest is of another backup`
				)
			backup = {
				archive_name: manifest.archive_name,
				archive_sha256: manifest.archive_sha256,
				checked_at: manifest.checked_at
			}
		}

		if (command === 'dry-run' || command === 'apply') {
			const brands = await db.collection('brands').find({ status: 'active' }).toArray()
			const brandsByName = new Map(brands.map(row => [row.name, row._id]))
			const missingBrands = Object.keys(brandSlugs).filter(brand => !brandsByName.has(brand))
			if (command === 'apply' && missingBrands.length) {
				// Explicit, idempotent bootstrap of the reviewed brand list; unused until products link.
				await db.collection('brands').createIndex({ slug: 1 }, { unique: true })
				for (const brand of missingBrands)
					await db.collection('brands').updateOne(
						{ slug: brandSlugs[brand] },
						{
							$setOnInsert: {
								name: brand,
								slug: brandSlugs[brand],
								status: 'active',
								createdAt: new Date(),
								updatedAt: new Date()
							}
						},
						{ upsert: true }
					)
				for (const row of await db
					.collection('brands')
					.find({ status: 'active' })
					.toArray())
					brandsByName.set(row.name, row._id)
			} else if (command === 'dry-run')
				for (const brand of missingBrands)
					brandsByName.set(brand, new (require('mongodb').ObjectId)())
			const load = collection =>
				db
					.collection(collection)
					.find({ category_id: category._id })
					.sort({ _id: 1 })
					.toArray()
			const { patches, report } = buildV2MigrationPlan({
				category,
				products: await load('products'),
				variants: await load('product_variants'),
				landings: await load('landings'),
				brandsByName,
				colors: await db
					.collection('colors')
					.find({}, { projection: { name_uk: 1, name_en: 1, family: 1 } })
					.toArray(),
				mapping
			})
			// The journal's own limits, so dry-run refuses what apply would (one operation).
			if (patches.length > PLAN_MAX_TARGETS)
				throw Error(
					`PLAN_TOO_LARGE: ${patches.length} targets, one journal operation takes at most ${PLAN_MAX_TARGETS}`
				)
			if (BSON.calculateObjectSize({ patches }) > PLAN_MAX_BYTES)
				throw Error('PLAN_TOO_LARGE')
			if (command === 'dry-run') {
				console.log(
					JSON.stringify(
						{
							mode: 'dry-run',
							database: name,
							targets: patches.length,
							brands_to_create: missingBrands,
							plan_hash: hash(patches),
							report
						},
						null,
						1
					)
				)
				return
			}
			const baseline = await fingerprint(db, category._id)
			await runs.insertOne({
				_id: operation,
				kind: 'v2-migration',
				category_id: category._id,
				baseline,
				plan_hash: hash(patches),
				...(backup && { backup })
			})
			await gate.initialize()
			const token = await gate.acquire(
				operation,
				hash(patches),
				`cli-${randomUUID()}`,
				(await gate.readStamp()).revision
			)
			await prepareOrRelease(db, gate, journal, token, patches)
			await journal.execute(token, 'apply')
			if (hash(await fingerprint(db, category._id)) !== hash(baseline))
				throw Error('LEGACY_DATA_CHANGED')
			await verifyMigrated(
				db,
				category._id,
				Boolean(mapping.brand_key),
				mapping.product_name_addition
			)
			await gate.publishVerified(token)
			console.log(
				JSON.stringify({
					operation,
					status: 'completed',
					targets: patches.length,
					revision: token.revision + 1,
					legacy_fingerprint_unchanged: true,
					report
				})
			)
			return
		}

		const run = await runs.findOne({ _id: operation })
		if (!run || run.kind !== 'v2-migration') throw Error('MIGRATION_RUN_NOT_FOUND')
		const legacyUnchanged = async () =>
			hash(await fingerprint(db, run.category_id)) === hash(run.baseline)
		// Production recovery: the operator still holds the backup the run recorded.
		if (where.mode === 'production' && command !== 'inspect') {
			if (!run.backup?.archive_sha256) throw Error('RUN_HAS_NO_BACKUP_RECORD')
			await target.verifyBackupManifest(invocation.backupManifest, {
				sha256: run.backup.archive_sha256
			})
		}
		if (command === 'inspect') {
			console.log(
				JSON.stringify({
					operation,
					status: (await gate.operation(operation))?.status,
					inspection: await journal.inspect(operation),
					legacy_fingerprint_unchanged: await legacyUnchanged()
				})
			)
			return
		}
		// resume / rollback of an interrupted operation: same recovery protocol as staging.
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
		// Claimed, but refused before its plan was stored (a CLI before prepareOrRelease, or a
		// crash between acquire and prepare): nothing was written, so the gate is simply released.
		if (
			state.phase === 'writing' &&
			state.writes_started === false &&
			!(await db.collection('catalog_mutation_plans').findOne({ _id: operation }))
		) {
			await gate.abortBeforeWrites({
				operationId: operation,
				ownerId: state.owner_id,
				revision: state.revision,
				epoch: state.epoch
			})
			console.log(JSON.stringify({ operation, status: 'aborted_before_writes' }))
			return
		}
		if (state.phase === 'published') {
			await gate.recoverPublication(
				{
					operationId: operation,
					ownerId: state.owner_id,
					revision: state.revision - (state.publication_outcome === 'completed' ? 1 : 0),
					epoch: state.epoch - 1
				},
				true
			)
			console.log(JSON.stringify({ operation, status: 'publication_reconciled' }))
			return
		}
		const previous =
			state.phase === 'recovering'
				? state.recovery_from
				: {
						operationId: operation,
						ownerId: state.owner_id,
						revision: state.revision,
						epoch: state.epoch
					}
		const next = await gate.claimRecovery(
			previous,
			state.phase === 'recovering' ? state.owner_id : `cli-${randomUUID()}`,
			true
		)
		await journal.adoptRecovery(previous, next)
		await gate.finishRecovery(previous, next)
		await journal.execute(next, command === 'rollback' ? 'rollback' : 'apply')
		if (!(await legacyUnchanged())) throw Error('LEGACY_DATA_CHANGED')
		if (command === 'rollback') await gate.finishRolledBack(next)
		else {
			await verifyMigrated(
				db,
				run.category_id,
				Boolean(mapping.brand_key),
				mapping.product_name_addition
			)
			await gate.publishVerified(next)
		}
		console.log(
			JSON.stringify({
				operation,
				status: command === 'rollback' ? 'rolled_back' : 'completed'
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
module.exports = { fingerprint, verifyMigrated, main, parseInvocation }
