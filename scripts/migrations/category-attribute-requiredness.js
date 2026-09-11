/** Full raw-data migration. See category-attribute-requiredness.md for the release procedure. */
const { isDeepStrictEqual } = require('node:util')
const { createHash } = require('node:crypto')
const { BSON, MongoClient } = require('mongoose').mongo

const VERSION = 'category-attribute-requiredness-v1'
const JOURNAL = 'catalog_migrations'
const OPTIONAL_KEYS = ['finish', 'reinforcement']
const equal = isDeepStrictEqual
const digest = entries =>
	createHash('sha256')
		.update(BSON.EJSON.stringify(entries, { relaxed: false }))
		.digest('hex')

function inspect(categories, requireFlags = false) {
	if (!categories.length) throw new Error('No categories found; refusing an empty/wrong database')
	const errors = []
	let fields = 0,
		required = 0,
		optional = 0
	const ids = new Set()
	for (const category of categories) {
		const id = String(category._id)
		if (!category._id || ids.has(id)) errors.push(`${id}: missing/duplicate category identity`)
		ids.add(id)
		if (!Array.isArray(category.required_attributes)) {
			errors.push(`${id}: required_attributes must be an array`)
			continue
		}
		const keys = new Set()
		for (const attr of category.required_attributes) {
			if (!attr || typeof attr.key !== 'string' || !attr.key.trim() || keys.has(attr.key)) {
				errors.push(`${id}: malformed/duplicate attribute key`)
				continue
			}
			keys.add(attr.key)
			fields++
			if (attr.is_required === true) required++
			else if (attr.is_required === false) optional++
			else if (requireFlags || Object.hasOwn(attr, 'is_required'))
				errors.push(`${id}/${attr.key}: is_required must be a stored boolean`)
		}
	}
	if (errors.length) throw new Error(errors.join('\n'))
	return {
		categories: categories.length,
		fields,
		required,
		optional,
		missing: fields - required - optional
	}
}

function plan(categories) {
	inspect(categories)
	const filament = categories.filter(category => category.slug === 'filament')
	if (filament.length !== 1) throw new Error('Expected exactly one filament category')
	for (const key of OPTIONAL_KEYS) {
		if (!filament[0].required_attributes.some(attr => attr.key === key))
			throw new Error(`filament: missing ${key}`)
	}
	return categories.map(before => {
		const after = {
			...before,
			required_attributes: before.required_attributes.map(attr => {
				const is_required = !(
					before.slug === 'filament' && OPTIONAL_KEYS.includes(attr.key)
				)
				if (Object.hasOwn(attr, 'is_required') && attr.is_required !== is_required) {
					throw new Error(
						`${before._id}/${attr.key}: existing flag conflicts with initial migration plan`
					)
				}
				return { ...attr, is_required }
			})
		}
		return { before, after }
	})
}

function verifyPlanRecord(record) {
	if (
		record._id !== VERSION ||
		!Array.isArray(record.entries) ||
		record.checksum !== digest(record.entries)
	) {
		throw new Error('Migration backup is missing or corrupt; no category writes allowed')
	}
	// Verify the saved target is exactly the transformation we reviewed, not just valid JSON.
	if (!equal(plan(record.entries.map(entry => entry.before)), record.entries))
		throw new Error('Saved plan does not match migration rules')
}

function matchSnapshot(categories, entries, mode) {
	if (categories.length !== entries.length) throw new Error('Category set changed since backup')
	const byId = new Map(categories.map(category => [String(category._id), category]))
	for (const entry of entries) {
		const current = byId.get(String(entry.before._id))
		const valid =
			mode === 'either'
				? equal(current, entry.before) || equal(current, entry.after)
				: equal(current, entry[mode])
		if (!valid)
			throw new Error(
				`${entry.before._id}: category changed outside this migration; refusing overwrite`
			)
	}
}

async function migrate(db, options = {}, log = console.log) {
	const { apply = false, resume = false, rollback = false, verify = false } = options
	const categories = db.collection('categories')
	const journal = db.collection(JOURNAL)
	const read = () => categories.find({}).toArray() // Raw driver: no schema defaults/casting.
	let record = await journal.findOne({ _id: VERSION })
	const current = await read()

	if (record) verifyPlanRecord(record)
	if (verify || (record?.status === 'complete' && !rollback)) {
		if (record?.status !== 'complete') throw new Error('Migration has not completed')
		const counts = inspect(current, true)
		log(
			`Verified completed migration: ${JSON.stringify(counts)}. Current administrator settings preserved.`
		)
		return counts
	}
	if (record?.status === 'rolled_back') {
		matchSnapshot(current, record.entries, 'before')
		if (rollback) {
			log('Already rolled back and verified.')
			return
		}
		throw new Error(
			'Migration was rolled back. Keep this backup; use a reviewed new migration version to reapply.'
		)
	}
	if (rollback && !record) throw new Error('No backup exists to roll back')
	if (resume && !record) throw new Error('No saved plan exists to resume')
	if (record?.status === 'rolling_back' && !rollback)
		throw new Error('Rollback is in progress; resume with --rollback --apply')
	if (record && !['pending', 'complete', 'rolling_back'].includes(record.status))
		throw new Error('Unknown migration status')
	if (record && apply && !resume && !rollback)
		throw new Error('Unfinished migration: stop other runners, then use --resume --apply')

	const entries = record?.entries ?? plan(current)
	matchSnapshot(current, entries, 'either')
	const counts = inspect(
		entries.map(entry => entry.after),
		true
	)
	const changed = entries.filter(entry => !equal(entry.before, entry.after)).length
	log(
		`${rollback ? 'ROLLBACK' : 'PLAN'}: ${JSON.stringify(counts)}, categories to change: ${changed}`
	)
	for (const entry of entries) {
		log(
			`${entry.before._id} (${entry.before.slug}): ${entry.after.required_attributes.map(attr => `${attr.key}=${attr.is_required}`).join(', ')}`
		)
	}
	if (!apply) {
		log('Dry run: no writes. Use --apply to execute.')
		return counts
	}

	if (!record) {
		record = {
			_id: VERSION,
			status: 'pending',
			created_at: new Date(),
			database: db.databaseName,
			entries,
			checksum: digest(entries)
		}
		if (BSON.calculateObjectSize(record) > 12 * 1024 * 1024)
			throw new Error('Backup exceeds 12 MiB; split migration before applying')
		// A unique _id prevents two first-time runners from both taking ownership.
		await journal.insertOne(record, { writeConcern: { w: 'majority' } })
		const saved = await journal.findOne({ _id: VERSION })
		verifyPlanRecord(saved)
		if (!equal(saved.entries, entries)) throw new Error('Backup read-back mismatch')
	}
	if (rollback && record.status !== 'rolling_back') {
		const result = await journal.updateOne(
			{ _id: VERSION, status: record.status, checksum: record.checksum },
			{ $set: { status: 'rolling_back' } },
			{ writeConcern: { w: 'majority' } }
		)
		if (result.matchedCount !== 1) throw new Error('Migration status changed concurrently')
	}

	// Preflight ALL documents again before any category write, including on resume/rollback.
	matchSnapshot(await read(), entries, 'either')
	for (const entry of entries) {
		const from = rollback ? entry.after : entry.before
		const to = rollback ? entry.before : entry.after
		const actual = await categories.findOne({ _id: from._id })
		if (equal(actual, to)) continue // Already applied by a previous interrupted run.
		if (!equal(actual, from)) throw new Error(`${from._id}: concurrent modification`)
		const result = await categories.updateOne(
			{ _id: from._id, $expr: { $eq: ['$$ROOT', { $literal: from }] } },
			{ $set: { required_attributes: to.required_attributes } },
			{ writeConcern: { w: 'majority' } }
		)
		if (result.matchedCount !== 1)
			throw new Error(
				`${from._id}: write conflict; keep catalogue writes paused and resume/rollback`
			)
	}
	const after = await read()
	matchSnapshot(after, entries, rollback ? 'before' : 'after')
	const resultCounts = inspect(after, !rollback)
	const completed = await journal.updateOne(
		{ _id: VERSION, checksum: record.checksum, status: rollback ? 'rolling_back' : 'pending' },
		{
			$set: {
				status: rollback ? 'rolled_back' : 'complete',
				verified_at: new Date(),
				counts: resultCounts
			}
		},
		{ writeConcern: { w: 'majority' } }
	)
	if (completed.matchedCount !== 1)
		throw new Error(
			'Could not mark verified migration complete; inspect journal before retrying'
		)
	log(`${rollback ? 'ROLLED BACK' : 'COMPLETE'}: ${JSON.stringify(resultCounts)}`)
	return resultCounts
}

function parseArgs(args) {
	const flags = new Set(['--dry-run', '--apply', '--resume', '--rollback', '--verify'])
	if (args.some(arg => !flags.has(arg)))
		throw new Error(
			'Unknown argument. Use --dry-run, --apply, --resume, --rollback or --verify'
		)
	if (args.includes('--dry-run') && args.includes('--apply'))
		throw new Error('Choose --dry-run or --apply')
	if (
		args.includes('--verify') &&
		args.some(arg => ['--apply', '--resume', '--rollback'].includes(arg))
	)
		throw new Error('--verify is read-only and cannot be combined with write modes')
	if (args.includes('--resume') && args.includes('--rollback'))
		throw new Error('Choose --resume or --rollback')
	return {
		apply: args.includes('--apply'),
		resume: args.includes('--resume'),
		rollback: args.includes('--rollback'),
		verify: args.includes('--verify')
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	require('dotenv').config({ quiet: true })
	const url = process.env.DATABASE_URL
	if (!url || !/^mongodb(?:\+srv)?:\/\/[^/]+\/[^?]+/.test(url))
		throw new Error('DATABASE_URL must include an explicit database name')
	const client = new MongoClient(url, { serverSelectionTimeoutMS: 10000 })
	try {
		await client.connect()
		console.log(`Database: ${client.options.dbName}; migration: ${VERSION}`)
		await migrate(client.db(), options)
	} finally {
		await client.close()
	}
}
module.exports = { VERSION, JOURNAL, inspect, plan, migrate, parseArgs }
if (require.main === module)
	main().catch(error => {
		console.error(error.message)
		process.exitCode = 1
	})
