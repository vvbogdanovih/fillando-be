#!/usr/bin/env node
// Recovers an interrupted catalogue write of the new admin (any HTTP writer: categories, products,
// landings, colours, addresses, storefront settings) — the operator path TD-0013 §3 requires.
// A writer that fails after its first domain write, or a process that dies mid-save, leaves
// `catalog_control` closed (`writing` / `recovery_required` / `recovering` / `published`): every
// catalogue read and checkout answers 503 until the operation is rolled back or resumed here.
// A refusal before the first write releases the gate by itself (`afterFailedWrite`), and so does
// this CLI when nothing was written.
//
// The journal holds the before- and after-image of every target, so `rollback` restores the
// state before the save and `resume` finishes it; both are verified against the journal before
// the gate opens. Migration and staging runs keep their own CLIs (`catalog-v2-migrate.cjs`,
// `catalog-stage.cjs`), which also check the legacy fingerprint. Stop every writer first (the
// API, cron, Prom sync): recovery takes the operation over and does not fence a live process.
// Target guard as in catalog-v2-migrate.cjs (`catalog-cli-target.cjs`).
const { MongoClient } = require('mongodb')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const target = require('./catalog-cli-target.cjs')

const COMMANDS = ['inspect', 'resume', 'rollback']
const USAGE = `Usage:
  catalog-recover.cjs inspect <database> [<operation-id>] [--production]
  catalog-recover.cjs resume|rollback <database> <operation-id> --writers-stopped
      [--production --confirm=<command>:fillando-prod:<operation-id>]`

/** Validates the whole invocation before anything connects or loads application code. */
function parseInvocation(
	args,
	env = process.env,
	envFiles = target.readEnvFiles(path.join(__dirname, '..'))
) {
	const [command, database, ...rest] = args
	if (!COMMANDS.includes(command)) throw Error(USAGE)
	const operation = rest[0] && !rest[0].startsWith('--') ? rest.shift() : undefined
	if (operation !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(operation))
		throw Error('Invalid operation ID')
	if (command !== 'inspect' && !operation) throw Error('Explicit operation ID required')
	if (rest.some(flag => !/^--(writers-stopped|production|confirm=.+)$/.test(flag)))
		throw Error('Unknown option')
	const production = rest.includes('--production')
	const where = target.resolveTarget({ database, production, env, envFiles })
	if (!production && rest.some(flag => flag.startsWith('--confirm=')))
		throw Error('--confirm belongs to --production')
	if (command !== 'inspect') {
		if (!rest.includes('--writers-stopped'))
			throw Error('Stop all writers and pass --writers-stopped')
		target.requireConfirmation(where, rest, [command, database, operation])
	}
	return { command, database, operation, target: where }
}

/** The gate without its owner token (never printed). */
function describeControl(control) {
	return control
		? {
				phase: control.phase,
				operation_id: control.operation_id,
				writes_started: control.writes_started,
				revision: control.revision,
				epoch: control.epoch,
				...(control.publication_outcome && {
					publication_outcome: control.publication_outcome
				})
			}
		: null
}

async function main(args) {
	const invocation = parseInvocation(args)
	const { command, database, target: where } = invocation
	require('ts-node').register({ transpileOnly: true })
	require('tsconfig-paths/register')
	const { CatalogWriteGate } = require('../src/database/mongoose/repositories/catalog-write-gate')
	const {
		CatalogMutationJournal
	} = require('../src/database/mongoose/repositories/catalog-mutation-journal')
	if (where.mode === 'production')
		console.error(JSON.stringify({ target: target.describeTarget(where), command }))
	const client = await new MongoClient(where.uri, {
		serverSelectionTimeoutMS: where.mode === 'production' ? 15000 : 3000,
		readPreference: 'primary',
		appName: 'fillando-catalog-recover'
	}).connect()
	try {
		const db = client.db(database)
		const gate = new CatalogWriteGate(db)
		// Execute/inspect/adopt do not depend on the writer profile (it only limits prepare).
		const journal = new CatalogMutationJournal(db, gate)
		const plans = db.collection('catalog_mutation_plans')
		const control = () =>
			db
				.collection('catalog_control')
				.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		const state = await control()
		const operation = invocation.operation ?? state?.operation_id ?? undefined

		if (command === 'inspect') {
			const plan = operation && (await plans.findOne({ _id: operation }))
			console.log(
				JSON.stringify({
					control: describeControl(state),
					operation: operation ?? null,
					status: operation ? ((await gate.operation(operation))?.status ?? null) : null,
					journal: plan ? await journal.inspect(operation) : null
				})
			)
			return
		}
		if (await db.collection('catalog_stage_runs').findOne({ _id: operation }))
			throw Error(
				'MIGRATION_OR_STAGING_RUN: recover it with catalog-v2-migrate.cjs or catalog-stage.cjs'
			)
		const receipt = await gate.operation(operation)
		if (state?.operation_id !== operation) {
			if (['completed', 'rolled_back', 'aborted', 'rejected'].includes(receipt?.status)) {
				console.log(
					JSON.stringify({ operation, status: receipt.status, already_finished: true })
				)
				return
			}
			throw Error('OPERATION_NOT_CURRENT')
		}
		const token = {
			operationId: operation,
			ownerId: state.owner_id,
			revision: state.revision,
			epoch: state.epoch
		}
		// Nothing was written (refused before the first domain write, or a crash before it): the
		// gate is simply released, whatever was asked — the save never happened.
		if (state.phase === 'writing' && state.writes_started === false) {
			await gate.abortBeforeWrites(token)
			console.log(JSON.stringify({ operation, status: 'aborted_before_writes' }))
			return
		}
		// Crashed between publishing and opening the gate: only the bookkeeping is finished.
		if (state.phase === 'published') {
			await gate.recoverPublication(
				{
					...token,
					revision: state.revision - (state.publication_outcome === 'completed' ? 1 : 0),
					epoch: state.epoch - 1
				},
				true
			)
			console.log(JSON.stringify({ operation, status: 'publication_reconciled' }))
			return
		}
		if (!(await plans.findOne({ _id: operation }))) throw Error('PLAN_MISSING')
		const previous = state.phase === 'recovering' ? state.recovery_from : token
		const next = await gate.claimRecovery(
			previous,
			state.phase === 'recovering' ? state.owner_id : `cli-${randomUUID()}`,
			true
		)
		await journal.adoptRecovery(previous, next)
		await gate.finishRecovery(previous, next)
		const direction = command === 'rollback' ? 'rollback' : 'apply'
		await journal.execute(next, direction)
		// The gate opens only when every target is at the chosen image.
		const { counts, targets } = await journal.inspect(operation)
		const reached = (command === 'rollback' ? counts.before : counts.after) + counts.both
		if (reached !== targets || counts.conflict || counts.missing)
			throw Error(`RECOVERY_VERIFICATION_FAILED: ${JSON.stringify(counts)}`)
		await verifyTree(db, operation)
		if (command === 'rollback') await gate.finishRolledBack(next)
		else await gate.publishVerified(next)
		console.log(
			JSON.stringify({
				operation,
				status: command === 'rollback' ? 'rolled_back' : 'completed',
				targets,
				control: describeControl(await control())
			})
		)
	} finally {
		await client.close()
	}
}

/** A plan that touched categories leaves a valid tree (every row parses, no cycle). */
async function verifyTree(db, operation) {
	const plan = await db.collection('catalog_mutation_plans').findOne({ _id: operation })
	if (!plan.patches.some(patch => patch.collection === 'categories')) return
	const { readCategoryConfiguration } = require('../src/modules/category/category-configuration')
	const { projectCategoryTree } = require('../src/modules/category/category-tree-read')
	const { CategoryTree } = require('../src/modules/category/category-tree')
	const rows = []
	for await (const row of db.collection('categories').find({}, { batchSize: 1000 })) {
		readCategoryConfiguration({
			...row,
			parent_id: row.parent_id == null ? null : String(row.parent_id)
		})
		rows.push(row)
	}
	new CategoryTree(
		projectCategoryTree(rows, true).map(item => ({
			id: item._id,
			parent_id: item.parent_id,
			kind: item.kind
		}))
	)
}

if (require.main === module)
	main(process.argv.slice(2)).catch(error => {
		console.error(error.message)
		process.exitCode = 1
	})
module.exports = { main, parseInvocation }
