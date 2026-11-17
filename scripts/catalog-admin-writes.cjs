#!/usr/bin/env node
// Switches the new admin's catalogue writes (`catalog_control.admin_draft_writes_enabled`), the
// step that reopens editing after the v1→v2 migration (Plan-0010 D08 §3.9). Idempotent; reports
// the state before and after. The flag only lets journal-backed admin writers start: a write
// still needs `phase: idle` and passes the gate, so enabling never bypasses the journal.
// Target guard as in catalog-v2-migrate.cjs (`catalog-cli-target.cjs`): DATABASE_URL of the backend,
// a remote server only with `--production`, database `fillando-prod` and
// `--confirm=<command>:fillando-prod` for a change.
const { MongoClient } = require('mongodb')
const path = require('node:path')
const target = require('./catalog-cli-target.cjs')

const COMMANDS = ['status', 'enable', 'disable']
const USAGE = `Usage: catalog-admin-writes.cjs status|enable|disable <database> [--production [--confirm=<command>:fillando-prod]]`

function parseInvocation(
	args,
	env = process.env,
	envFiles = target.readEnvFiles(path.join(__dirname, '..'))
) {
	const [command, database, ...flags] = args
	if (!COMMANDS.includes(command)) throw Error(USAGE)
	if (flags.some(flag => flag !== '--production' && !flag.startsWith('--confirm=')))
		throw Error('Unknown option')
	const production = flags.includes('--production')
	const where = target.resolveTarget({ database, production, env, envFiles })
	if (!production && flags.some(flag => flag.startsWith('--confirm=')))
		throw Error('--confirm belongs to --production')
	if (command !== 'status') target.requireConfirmation(where, flags, [command, database])
	return { command, target: where }
}

/** Snapshot of what decides whether the new admin can write. */
async function readState(db) {
	const control = await db
		.collection('catalog_control')
		.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
	return {
		control_present: Boolean(control),
		phase: control?.phase ?? null,
		revision: control?.revision ?? null,
		operation_id: control?.operation_id ?? null,
		admin_draft_writes_enabled: control?.admin_draft_writes_enabled === true,
		// What the admin actually gets (`GET /categories/admin/capabilities` → draft_writes_enabled).
		new_admin_can_write:
			control?.admin_draft_writes_enabled === true && control.phase === 'idle',
		// Without control the legacy admin writes and the new one is closed (pre-migration state).
		legacy_admin_can_write: !control,
		v2_categories: await db
			.collection('categories')
			.countDocuments({ attribute_contract_version: 2 })
	}
}

async function main(args) {
	const { command, target: where } = parseInvocation(args)
	const client = await new MongoClient(where.uri, {
		serverSelectionTimeoutMS: where.mode === 'production' ? 15000 : 3000,
		readPreference: 'primary',
		appName: 'fillando-catalog-admin-writes'
	}).connect()
	try {
		const db = client.db(where.database)
		const before = await readState(db)
		const report = { target: target.describeTarget(where), command, before }
		if (command === 'status') return console.log(JSON.stringify(report, null, 1))
		if (!before.control_present)
			throw Error(
				'CATALOG_CONTROL_MISSING: nothing to switch — the catalogue was never migrated (the legacy admin still writes)'
			)
		const enable = command === 'enable'
		if (before.admin_draft_writes_enabled === enable) {
			console.log(JSON.stringify({ ...report, result: 'unchanged', after: before }, null, 1))
			return
		}
		// Opening writes mid-operation would let an admin queue behind a journal that still
		// needs recovery; closing them is always allowed.
		const filter = enable ? { _id: 'catalog', phase: 'idle' } : { _id: 'catalog' }
		const changed = await db
			.collection('catalog_control', { writeConcern: { w: 1, j: true } })
			.updateOne(filter, {
				$set: {
					admin_draft_writes_enabled: enable,
					admin_draft_writes_changed_at: new Date()
				}
			})
		if (!changed.matchedCount)
			throw Error(
				`CATALOG_NOT_IDLE: phase is ${before.phase} (operation ${before.operation_id}); finish it with inspect/resume/rollback first`
			)
		console.log(
			JSON.stringify({ ...report, result: 'changed', after: await readState(db) }, null, 1)
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
module.exports = { main, parseInvocation, readState }
