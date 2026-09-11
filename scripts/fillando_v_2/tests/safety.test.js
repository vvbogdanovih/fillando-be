const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Types } = require('mongoose')
const { validateArgs } = require('../run-all')
const {
	planProducts,
	mergeJournal,
	applyRename,
	parkedSlug,
	LONG_PREFIX
} = require('../rename-products-short')
const { report } = require('../verify-catalog-state')

const productId = new Types.ObjectId('111111111111111111111111')
const variantId = new Types.ObjectId('222222222222222222222222')
const oldName = `${LONG_PREFIX}PLA 1,75 мм 1 кг`
const entry = () => ({
	product_id: String(productId),
	old_name: oldName,
	new_name: 'PLA',
	variants: [
		{
			_id: variantId,
			sku: 'FL-1',
			old_slug: 'old-pla-black',
			new_slug: 'pla-black',
			old_name: `${oldName} — Чорний (Black)`,
			new_name: 'PLA — Чорний (Black)',
			parked: false
		}
	]
})

test('CLI rejects misspelled and conflicting flags before connecting', () => {
	assert.throws(() => validateArgs(['--dryrun']), /Unknown/)
	assert.throws(() => validateArgs(['--colors-only', '--include-colors']), /Choose/)
	assert.doesNotThrow(() => validateArgs(['--dry-run', '--include-colors']))
	const res = spawnSync(process.execPath, [path.join(__dirname, '../run-all.js'), '--dryrun'], {
		encoding: 'utf8',
		env: { ...process.env, DATABASE_URL: 'mongodb://127.0.0.1:1/never-connect' }
	})
	assert.equal(res.status, 1)
	assert.match(res.stderr, /Unknown/)
})

test('noninteractive apply cannot silently write without --yes', () => {
	const res = spawnSync(process.execPath, [path.join(__dirname, '../run-all.js')], {
		encoding: 'utf8',
		env: { ...process.env, DATABASE_URL: 'mongodb://127.0.0.1:1/never-connect' }
	})
	assert.equal(res.status, 1)
	assert.match(res.stderr, /requires --yes/)
})

test('missing catalogue cannot pass verification', async () => {
	assert.equal(await report({ collection: () => ({ findOne: async () => null }) }), false)
})

test('second pass preserves original rollback journal and rejects another database', () => {
	const original = mergeJournal(null, { generated_for: 'rehearsal', renamed: [entry()] })
	const repeated = mergeJournal(original, { generated_for: 'rehearsal', renamed: [] })
	assert.deepEqual(repeated, original)
	const recovery = entry()
	recovery.old_name = 'PLA'
	recovery.variants[0].old_slug = parkedSlug('pla-black', variantId)
	assert.deepEqual(
		mergeJournal(original, { generated_for: 'rehearsal', renamed: [recovery] }),
		original
	)
	assert.throws(
		() => mergeJournal(original, { generated_for: 'other', renamed: [] }),
		/another database/
	)
})

function memoryCollection(docs, fault) {
	return {
		findOne: async filter =>
			docs.find(doc =>
				Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v))
			) ?? null,
		updateOne: async (filter, update) => {
			if (fault) fault(filter, update)
			const doc = docs.find(doc =>
				Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v))
			)
			if (!doc) return { matchedCount: 0 }
			Object.assign(doc, update.$set)
			return { matchedCount: 1 }
		}
	}
}

test('resume after product rename but before variant unpark completes names and slugs', async () => {
	const products = [{ _id: productId, name: oldName }]
	const variants = [
		{
			_id: variantId,
			product_id: productId,
			sku: 'FL-1',
			slug: 'old-pla-black',
			name: entry().variants[0].old_name,
			v_value: 'Black'
		}
	]
	const productRepo = memoryCollection(products)
	let writes = 0
	const brokenRepo = memoryCollection(variants, () => {
		if (++writes === 2) throw new Error('simulated crash')
	})
	await assert.rejects(
		() => applyRename(brokenRepo, productRepo, entry(), [], []),
		/simulated crash/
	)
	assert.equal(products[0].name, 'PLA')
	assert.equal(variants[0].slug, parkedSlug('pla-black', variantId))
	const plan = planProducts(products, variants, new Map(), { [oldName]: 'PLA' })
	assert.equal(plan.renamed.length, 1)
	const skipped = []
	await applyRename(memoryCollection(variants), productRepo, plan.renamed[0], [], skipped)
	assert.equal(skipped.length, 0)
	assert.equal(variants[0].slug, 'pla-black')
	assert.equal(variants[0].name, 'PLA — Black')
	assert.equal(
		planProducts(products, variants, new Map(), { [oldName]: 'PLA' }).renamed.length,
		0
	)
})

test('an edited product is refused before any variant is parked', async () => {
	const variants = [{ _id: variantId, slug: 'old-pla-black' }]
	const skipped = []
	await applyRename(
		memoryCollection(variants),
		memoryCollection([{ _id: productId, name: 'Edited' }]),
		entry(),
		[],
		skipped
	)
	assert.equal(variants[0].slug, 'old-pla-black')
	assert.equal(skipped.length, 1)
})

test('failed restore stops rehearsal before migration and cleans up its own container', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fillando-harness-test-'))
	try {
		const bin = path.join(root, 'bin')
		fs.mkdirSync(bin)
		const dump = path.join(root, 'dump')
		fs.mkdirSync(dump)
		for (const c of ['products', 'categories', 'product_variants'])
			fs.writeFileSync(path.join(dump, `${c}.bson`), 'fixture')
		const log = path.join(root, 'calls')
		const executable = (name, body) => {
			const file = path.join(bin, name)
			fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
			fs.chmodSync(file, 0o755)
		}
		executable(
			'docker',
			`echo "docker $*" >> "$CALL_LOG"\ncase "$1" in run) echo isolated-fixture;; port) echo 127.0.0.1:12345;; esac`
		)
		executable('mongorestore', 'echo restore >> "$CALL_LOG"; exit 9')
		executable('node', 'echo MIGRATION_MUST_NOT_RUN >> "$CALL_LOG"; exit 0')
		const res = spawnSync('bash', [path.join(__dirname, '../rehearse-on-dump.sh'), dump], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log }
		})
		assert.equal(res.status, 9)
		const calls = fs.readFileSync(log, 'utf8')
		assert.doesNotMatch(calls, /MIGRATION_MUST_NOT_RUN/)
		assert.match(calls, /docker rm -f isolated-fixture/)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})
