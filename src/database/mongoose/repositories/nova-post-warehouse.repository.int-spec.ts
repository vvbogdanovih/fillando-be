import { Model } from 'mongoose'
import { connectTestDb, dropTestDb } from '../../../../test/integration-db'
import { NovaPostWarehouse, NovaPostWarehouseSchema } from '../schemas/nova-post-warehouse.schema'
import { NovaPostWarehouseRepository } from './nova-post-warehouse.repository'

/**
 * The checkout's «Відділення» is post and cargo branches in one list. The type filter and the
 * order by number are both the database's work, so they are checked against a real MongoDB.
 */
type Conn = Awaited<ReturnType<typeof connectTestDb>>

const LOCKER = 'f9316480-5f2d-425d-bc2c-ac7cd29decf0'
const POST = '841339c7-591a-42e2-8233-7a0a00f0ed6f'
const CARGO = '9a68df70-0267-42a8-bb5c-37f427e36ee4'

describe('NovaPostWarehouseRepository.findByCityRef (MongoDB integration)', () => {
	let conn: Conn
	let repo: NovaPostWarehouseRepository
	let model: Model<NovaPostWarehouse>

	const warehouse = (
		number: number,
		typeOfWarehouse: string,
		description: string,
		cityRef = 'city-1'
	): NovaPostWarehouse => ({
		ref: `${cityRef}-${number}`,
		description,
		shortAddress: description,
		number,
		cityRef,
		cityName: 'Місто',
		maxWeightAllowed: 30,
		typeOfWarehouse,
		postalCode: '00000'
	})

	beforeAll(async () => {
		conn = await connectTestDb('nova-post-warehouse')
		model = conn.model<NovaPostWarehouse>(NovaPostWarehouse.name, NovaPostWarehouseSchema)
		await model.init()
		repo = new NovaPostWarehouseRepository(model)
		// Stored out of order on purpose: the list must not depend on the order of the sync.
		await model.insertMany([
			warehouse(50673, POST, 'Пункт №50673 (до 10 кг): вул. Касіяна, 4'),
			warehouse(3, CARGO, 'Відділення №3: вул. Слобожанська, 13'),
			warehouse(48446, LOCKER, 'Поштомат №48446: вул. Зарічанська, 11'),
			warehouse(12, POST, 'Відділення №12 (до 30 кг): вул. Садова, 2'),
			warehouse(1, CARGO, 'Відділення №1: вул. Пирогівський шлях, 135'),
			warehouse(2, POST, 'Відділення №2 (до 30 кг): вул. Садова, 9', 'city-2')
		])
	})

	afterAll(async () => {
		await dropTestDb(conn)
	})

	const numbers = (rows: NovaPostWarehouse[]) => rows.map(r => r.number)

	it('returns post and cargo branches of the city together, ordered by number', async () => {
		const rows = await repo.findByCityRef('city-1', [POST, CARGO])

		expect(numbers(rows)).toEqual([1, 3, 12, 50673])
	})

	it('keeps a single type to itself', async () => {
		expect(numbers(await repo.findByCityRef('city-1', [LOCKER]))).toEqual([48446])
		expect(numbers(await repo.findByCityRef('city-1', [CARGO]))).toEqual([1, 3])
	})

	it('returns every kind when no type is given', async () => {
		expect(numbers(await repo.findByCityRef('city-1'))).toEqual([1, 3, 12, 48446, 50673])
	})

	it('searches by number and by address inside the combined list', async () => {
		expect(numbers(await repo.findByCityRef('city-1', [POST, CARGO], '5067'))).toEqual([50673])
		expect(numbers(await repo.findByCityRef('city-1', [POST, CARGO], 'слобожан'))).toEqual([3])
		expect(numbers(await repo.findByCityRef('city-1', [POST, CARGO], 'зарічанська'))).toEqual(
			[]
		)
	})
})
