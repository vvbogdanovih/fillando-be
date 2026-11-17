import mongoose, { mongo } from 'mongoose'
import { MongoClient } from 'mongodb'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { CatalogWriteGate } from 'src/database/mongoose/repositories/catalog-write-gate'
import { Category, CategorySchema } from 'src/database/mongoose/schemas/category.schema'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { CategoryService } from './category.service'
import { CategoryTreeWriter } from './category-tree-writer'
import { CategoryPublicReadService } from './category-public-read.service'
import { CategoryTreeReadService } from './category-tree-read.service'
import { FormerCategoryPublicReadService } from './__former__/category-public-read.former'
import { CATEGORY_MEMO_MS, categoryFingerprint, collectionWriteMark } from './category-fingerprint'

/**
 * Plan-0010 D06.3: the public reader keeps only the visible tree's topology in its memo and reads
 * a category's content on demand, keyed by an O(1) write mark of `categories`. These specs pin it
 * to the reader it replaced (a frozen copy) byte for byte on a mixed tree, and prove that every
 * kind of write — the journal, the legacy Mongoose writer, a CLI on its own client, a raw script —
 * is seen by the next read; `$merge`, which no server counter records, within `CATEGORY_MEMO_MS`.
 */
const oid = (n: number) => new mongo.ObjectId(n.toString(16).padStart(24, '0'))
const id = (n: number) => String(oid(n))
const definition = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
	key,
	label,
	value_type: 'string',
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
const at = new Date('2026-10-01T10:00:00Z')
const GROUP = {
	kind: 'group',
	status: 'active',
	attribute_contract_version: 2,
	attribute_definitions: []
}
const MIXED = [
	{
		_id: oid(1),
		name: 'Філамент',
		slug: 'filament',
		order: 3,
		image: 'https://cdn.example.invalid/f.webp',
		required_attributes: [
			{
				key: 'polymer',
				label: 'Тип пластику',
				filter_type: 'multi-select',
				is_required: true
			},
			{
				key: 'diametr',
				label: 'Діаметр',
				filter_type: 'range',
				is_required: false,
				unit: 'мм'
			}
		],
		presentation: { spec_order: ['polymer'], emphasised_values: ['1.75'] },
		seo: { title: 'Філамент', description: 'Опис', h1: null },
		google_product_category: { id: 499682, path: 'Electronics > 3D' },
		private_note: 'not public',
		createdAt: at,
		updatedAt: at
	},
	{ _id: oid(2), name: 'Електрика', slug: 'electric', order: 1, ...GROUP },
	{ _id: oid(3), name: 'Живлення', slug: 'power', parent_id: oid(2), order: 0, ...GROUP },
	{
		_id: oid(4),
		name: 'АВР',
		slug: 'avr',
		parent_id: oid(3),
		order: 2,
		kind: 'product',
		status: 'active',
		attribute_contract_version: 2,
		attribute_definitions: [
			definition('vyrobnyk', 'Виробник'),
			definition('current', 'Струм', {
				value_type: 'number',
				unit: 'А',
				filter_type: 'range',
				semantic: 'size',
				order: 1
			})
		],
		presentation: {
			attribute_notes: [
				{ key: 'current', value: '63', title: 'Увага', text: 'Великий струм', badge: null }
			]
		},
		seo: {
			title: null,
			description: null,
			h1: 'АВР',
			intro_html: '<p>x</p>',
			bottom_html: null
		},
		createdAt: at,
		updatedAt: at
	},
	{
		_id: oid(5),
		name: 'Ковдри',
		slug: 'blankets',
		parent_id: oid(2),
		order: 2,
		kind: 'product',
		status: 'active',
		attribute_contract_version: 2,
		attribute_definitions: [
			definition('color', 'Колір', {
				semantic: 'color',
				filter_enabled: false,
				filter_type: null
			})
		]
	},
	{ _id: oid(6), name: 'Чернетки', slug: 'drafts', ...GROUP, status: 'draft' },
	{
		_id: oid(7),
		name: 'Прихована',
		slug: 'hidden',
		parent_id: oid(6),
		kind: 'product',
		status: 'active',
		attribute_contract_version: 2,
		attribute_definitions: []
	},
	{ _id: oid(8), name: 'Архів', slug: 'archived', status: 'archived', required_attributes: [] },
	{ _id: oid(9), name: 'Аксесуари', slug: 'accessories', order: 3, required_attributes: [] }
]
const json = (value: unknown) => JSON.stringify(value)
let former: FormerCategoryPublicReadService
let reader: CategoryPublicReadService
const categories = () => mongoose.connection.collection('categories')

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('public-read-parity')
})
afterAll(async () => {
	if (mongoose.connection.readyState === mongoose.ConnectionStates.connected)
		await dropTestDb(mongoose)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	await new CatalogWriteGate(mongoose.connection.db!).initialize()
	await categories().insertMany(MIXED.map(row => ({ ...row })))
	former = new FormerCategoryPublicReadService(mongoose.connection)
	reader = new CategoryPublicReadService(mongoose.connection)
})

describe('the same answers as before the light memo', () => {
	it('lists, details and the legacy list are byte for byte the former ones', async () => {
		expect(json(await reader.findAll())).toBe(json(await former.findAll()))
		const tree = await former.findVisibleTree()
		expect(tree.length).toBe(6)
		for (const node of tree) {
			expect(json(await reader.findById(node._id))).toBe(
				json(await former.findById(node._id))
			)
			expect(json(await reader.findBySlug(node.slug))).toBe(
				json(await former.findBySlug(node.slug))
			)
			expect(json(await reader.findVisibleById(node._id))).toBe(
				json(await former.findVisibleById(node._id))
			)
		}
		// The tree itself: the same nodes in the same order, without their content.
		const light = await reader.findVisibleTree()
		expect(light.map(node => node._id)).toEqual(tree.map(node => node._id))
		for (const [index, node] of light.entries())
			expect({
				_id: node._id,
				parent_id: node.parent_id,
				kind: node.kind,
				status: node.status,
				name: node.name,
				slug: node.slug,
				order: node.order,
				revision: node.revision,
				attribute_contract_version: node.attribute_contract_version
			}).toEqual({
				_id: tree[index]._id,
				parent_id: tree[index].parent_id,
				kind: tree[index].kind,
				status: tree[index].status,
				name: tree[index].name,
				slug: tree[index].slug,
				order: tree[index].order,
				revision: tree[index].revision,
				attribute_contract_version: tree[index].attribute_contract_version
			})
		expect((await reader.productCategories()).map(node => node._id)).toEqual(
			(await former.findAll()).map(node => node._id)
		)
	})
	it('reads the categories once for the reader, both tree audiences and the options', async () => {
		const find = jest.spyOn(categories(), 'find')
		try {
			const tree = new CategoryTreeReadService(mongoose.connection)
			await reader.findVisibleTree()
			await tree.read({}, false)
			await tree.read({}, true)
			await tree.read({}, false, id(2))
			await tree.readOptions({})
			await reader.productCategories()
			// Every category, placement only: one query; content reads are by id.
			expect(
				find.mock.calls.filter(([filter]) => JSON.stringify(filter) === '{}')
			).toHaveLength(1)
		} finally {
			find.mockRestore()
		}
	})
	it('answers hidden, archived and unknown ids as before', async () => {
		for (const missing of [id(6), id(7), id(8), id(99), 'not-an-id']) {
			await expect(reader.findById(missing)).rejects.toMatchObject({ status: 404 })
			await expect(former.findById(missing)).rejects.toMatchObject({ status: 404 })
			expect(await reader.findVisibleById(missing)).toBeUndefined()
		}
		const content = await reader.contentOf([id(4), id(7), id(4), id(1)])
		expect([...content.keys()]).toEqual([id(4), id(1)])
	})
	it('keeps at most the bounded number of parsed categories and reuses them', async () => {
		const first = await reader.findById(id(4))
		expect(await reader.findById(id(4))).toBe(first)
		// A bulk read past the cache returns fresh objects and leaves the cached one in place.
		const bulk = await reader.contentOf([id(4)], { cache: false })
		expect(bulk.get(id(4))).not.toBe(first)
		expect(await reader.findById(id(4))).toBe(first)
	})
	it('fails only the reads that need a broken category (deliberate: was every read)', async () => {
		await categories().updateOne({ _id: oid(5) }, { $set: { attribute_definitions: 'broken' } })
		await expect(former.findById(id(4))).rejects.toMatchObject({ status: 503 })
		await expect(reader.findById(id(5))).rejects.toMatchObject({
			status: 503,
			response: { details: { code: 'CATALOG_CATEGORY_DATA_UNAVAILABLE' } }
		})
		// The legacy list still fails closed: it parses every product category.
		await expect(reader.findAll()).rejects.toMatchObject({ status: 503 })
		expect((await reader.findById(id(4))).name).toBe('АВР')
		expect((await reader.findVisibleTree()).length).toBe(6)
	})
})

describe('every write is seen by the next read', () => {
	const renamedTo = async (name: string) => {
		// Warm the memo and the content cache first, so a stale answer would be served from them.
		await reader.findById(id(4))
		await reader.findVisibleTree()
		return name
	}
	const expectFresh = async (name: string, mark: string | null) => {
		expect(await categoryFingerprint(mongoose.connection)).not.toBe(mark)
		expect((await reader.findById(id(4))).name).toBe(name)
		expect((await reader.findVisibleTree()).find(node => node._id === id(4))!.name).toBe(name)
	}
	it('reads the O(1) mark on this server, not the full pass', async () => {
		expect(await collectionWriteMark(mongoose.connection, 'categories')).not.toBeNull()
		expect(await categoryFingerprint(mongoose.connection)).toMatch(/^mark:/)
	})
	it('the journal (published category details)', async () => {
		const name = await renamedTo('АВР журнал')
		const mark = await categoryFingerprint(mongoose.connection)
		const control = await mongoose.connection.collection('catalog_control').findOne({})
		await new CategoryTreeWriter(mongoose.connection.db!).updateDetails(
			{
				operationId: '9a1f4c62-1d5e-4b7f-9c1a-2b3c4d5e6f70',
				ownerId: 'parity',
				expectedRevision: control!.revision as number
			},
			{ id: id(4), name }
		)
		await expectFresh(name, mark)
	})
	it('the legacy Mongoose writer (CategoryService.update)', async () => {
		const name = await renamedTo('АВР legacy')
		const mark = await categoryFingerprint(mongoose.connection)
		const model = mongoose.connection.model(Category.name, CategorySchema)
		const service = new CategoryService(new CategoryRepository(model), reader, {
			revalidate: jest.fn()
		} as never)
		await service.update(id(4), { name })
		await expectFresh(name, mark)
	})
	describe('a CLI or a raw script on its own client', () => {
		let client: MongoClient
		beforeAll(async () => {
			client = await MongoClient.connect(
				`mongodb://127.0.0.1:27018/${mongoose.connection.db!.databaseName}`
			)
		})
		afterAll(() => client.close())
		const other = () => client.db(mongoose.connection.db!.databaseName).collection('categories')
		const writes: [string, (name: string) => Promise<unknown>][] = [
			['updateOne', name => other().updateOne({ _id: oid(4) }, { $set: { name } })],
			[
				'updateMany',
				name => other().updateMany({ _id: { $in: [oid(4)] } }, { $set: { name } })
			],
			[
				'replaceOne',
				async name => {
					const row = await other().findOne({ _id: oid(4) })
					await other().replaceOne({ _id: oid(4) }, { ...row!, name })
				}
			],
			[
				'findOneAndUpdate',
				name => other().findOneAndUpdate({ _id: oid(4) }, { $set: { name } })
			],
			[
				'bulkWrite (CLI)',
				name =>
					other().bulkWrite([
						{ updateOne: { filter: { _id: oid(4) }, update: { $set: { name } } } }
					])
			],
			[
				'deleteOne + insertOne',
				async name => {
					const row = await other().findOne({ _id: oid(4) })
					await other().deleteOne({ _id: oid(4) })
					await other().insertOne({ ...row!, name })
				}
			],
			[
				'drop + re-create',
				async name => {
					const rows = await other().find().toArray()
					await other().drop()
					await other().insertMany(
						rows.map(row => (String(row._id) === id(4) ? { ...row, name } : row))
					)
				}
			],
			[
				'rename over',
				async name => {
					const rows = await other().find().toArray()
					const db = client.db(mongoose.connection.db!.databaseName)
					await db
						.collection('categories_next')
						.insertMany(
							rows.map(row => (String(row._id) === id(4) ? { ...row, name } : row))
						)
					await db
						.collection('categories_next')
						.rename('categories', { dropTarget: true })
				}
			],
			[
				'$out',
				async name => {
					const db = client.db(mongoose.connection.db!.databaseName)
					await db
						.collection('categories_src')
						.insertMany(
							(await other().find().toArray()).map(row =>
								String(row._id) === id(4) ? { ...row, name } : row
							)
						)
					await db
						.collection('categories_src')
						.aggregate([{ $out: 'categories' }])
						.toArray()
				}
			]
		]
		it.each(writes)('%s', async (_kind, write) => {
			const name = await renamedTo(`АВР ${_kind}`)
			const mark = await categoryFingerprint(mongoose.connection)
			await write(name)
			await expectFresh(name, mark)
		})
		it('$merge: no counter records it — seen once the memo expires (CATEGORY_MEMO_MS)', async () => {
			const name = await renamedTo('АВР merge')
			const mark = await categoryFingerprint(mongoose.connection)
			await other()
				.aggregate([
					{ $match: { _id: oid(4) } },
					{ $set: { name } },
					{ $merge: { into: 'categories', whenMatched: 'replace' } }
				])
				.toArray()
			expect(await categoryFingerprint(mongoose.connection)).toBe(mark)
			expect((await reader.findById(id(4))).name).toBe('АВР')
			const now = Date.now()
			const clock = jest.spyOn(Date, 'now').mockReturnValue(now + CATEGORY_MEMO_MS)
			try {
				expect((await reader.findById(id(4))).name).toBe(name)
			} finally {
				clock.mockRestore()
			}
		})
	})
})

describe('a path too long to embed (Plan-0010 D06.4)', () => {
	// TD-0013 §6 stress: a chain of 20 000 levels with 200-character names (~9 MB of ancestors).
	const DEPTH = 20_000
	const longName = (n: number) => `Рівень ${n} ${'я'.repeat(200 - `Рівень ${n} `.length)}`
	const chain = (n: number) => oid(100_000 + n)
	beforeEach(async () => {
		await categories().deleteMany({})
		const rows = Array.from({ length: DEPTH }, (_, n) => ({
			_id: chain(n),
			parent_id: n === 0 ? null : chain(n - 1),
			name: longName(n),
			slug: `level-${n}`,
			order: 0,
			status: 'active',
			attribute_contract_version: 2,
			kind: n === DEPTH - 1 ? 'product' : 'group',
			attribute_definitions: []
		}))
		for (let at = 0; at < rows.length; at += 5000)
			await categories().insertMany(rows.slice(at, at + 5000))
	})
	it('marks the detail instead of embedding, and pages the whole path root first', async () => {
		const leaf = String(chain(DEPTH - 1))
		const detail = await reader.findById(leaf)
		expect(detail.name).toHaveLength(200)
		expect(detail).toMatchObject({
			ancestors: [],
			ancestors_paged: true,
			ancestors_total: DEPTH - 1
		})
		expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(2 * 1024 * 1024)
		// The pages, concatenated, are the path the former reader embedded whole.
		const embedded = (await former.findById(leaf)).ancestors
		expect(Buffer.byteLength(JSON.stringify(embedded))).toBeGreaterThan(8 * 1024 * 1024)
		const paged: unknown[] = []
		let cursor: string | undefined
		let pages = 0
		do {
			const page = await reader.ancestorsPage(leaf, { limit: 1000, cursor })
			expect(page.total).toBe(DEPTH - 1)
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024)
			paged.push(...page.items)
			cursor = page.next_cursor ?? undefined
			pages++
		} while (cursor)
		expect(pages).toBe(20)
		expect(json(paged)).toBe(json(embedded))
		// The middle of the chain still fits: embedded whole, unmarked, as before.
		const middle = String(chain(1000))
		expect(json(await reader.findById(middle))).toBe(json(await former.findById(middle)))
	})
	it('restarts a walk when the path or the revision changes', async () => {
		const leaf = String(chain(DEPTH - 1))
		const first = await reader.ancestorsPage(leaf, { limit: 1000 })
		// A rename of an ancestor (a raw write, no revision bump) changes the path.
		await categories().updateOne({ _id: chain(5) }, { $set: { name: 'Перейменовано' } })
		await expect(
			reader.ancestorsPage(leaf, { limit: 1000, cursor: first.next_cursor! })
		).rejects.toMatchObject({ status: 409 })
		const again = await reader.ancestorsPage(leaf, { limit: 1000 })
		expect(again.items[5].name).toBe('Перейменовано')
		await mongoose.connection
			.collection('catalog_control')
			.updateOne({}, { $inc: { revision: 1 } })
		await expect(
			reader.ancestorsPage(leaf, { limit: 1000, cursor: again.next_cursor! })
		).rejects.toMatchObject({ status: 409 })
		await expect(reader.ancestorsPage(leaf, { cursor: 'garbage' })).rejects.toMatchObject({
			status: 400
		})
		await expect(reader.ancestorsPage(String(oid(99)), {})).rejects.toMatchObject({
			status: 404
		})
		// A root has an empty path.
		expect(await reader.ancestorsPage(String(chain(0)), {})).toMatchObject({
			total: 0,
			items: [],
			next_cursor: null
		})
	})
})
