import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import mongoose from 'mongoose'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from '../../../test/integration-db'
import { PURGE_OUTBOX, StorefrontRevalidationService } from './storefront-revalidation.service'

/**
 * The storefront purge outbox (P12, owner decision 02.11.2026; P15 echo): a purge is kept in
 * MongoDB until the storefront answers 2xx — through an outage, across a restart — one delivery
 * per resource and window, never twice from two processes, and echoed once after delivery.
 */
const db = () => mongoose.connection.db!
const timings = {
	pollMs: 25,
	leaseMs: 400,
	echoMs: 150,
	windowMs: 150,
	backoffMs: 30,
	maxBackoffMs: 120
}
let server: Server
let endpoint: string
let answer = 200
const received: string[] = []
const services: StorefrontRevalidationService[] = []
const service = () => {
	const created = new StorefrontRevalidationService()
	services.push(created)
	return created
}
const until = async (check: () => boolean | Promise<boolean>, timeout = 5000) => {
	const end = Date.now() + timeout
	while (!(await check())) {
		if (Date.now() > end) throw new Error('timed out')
		await new Promise(resolve => setTimeout(resolve, 20))
	}
}
const pending = () => db().collection(PURGE_OUTBOX).countDocuments()
/** Delivered and echoed: something reached the storefront and nothing is owed any more. */
const settled = () => until(async () => received.length > 0 && (await pending()) === 0)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeAll(async () => {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable DB required')
	await connectTestDb('storefront-purges')
	server = createServer((request, response) => {
		let body = ''
		request.on('data', chunk => (body += chunk))
		request.on('end', () => {
			received.push((JSON.parse(body) as { resource: string }).resource)
			response.writeHead(answer, { 'Content-Type': 'application/json' }).end('{}')
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/revalidate`
})
afterAll(async () => {
	await new Promise(resolve => server.close(resolve))
	await dropTestDb(mongoose)
})
beforeEach(async () => {
	await mongoose.connection.dropDatabase()
	received.length = 0
	answer = 200
})
afterEach(() => {
	for (const created of services.splice(0)) created.detach()
})

it('delivers a purge, echoes it once, and leaves nothing behind', async () => {
	const purges = service()
	purges.attach(db(), { endpoint, timings })
	purges.revalidate('products', 'typed product edit')
	await settled()
	await pause(timings.leaseMs)
	expect(received).toEqual(['products', 'products'])
})

it('keeps a purge through a storefront outage and delivers it once it answers', async () => {
	const warn = jest.spyOn(
		(service() as unknown as { logger: { warn: () => void } }).logger,
		'warn'
	)
	const purges = services[0]
	answer = 503
	purges.attach(db(), { endpoint, timings })
	purges.revalidate('categories', 'category move')
	await until(async () => {
		const row = await db()
			.collection(PURGE_OUTBOX)
			.findOne({ _id: 'categories' as never })
		return (row?.attempts as number) >= 3
	})
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('not acknowledged after 3 attempts'))
	answer = 200
	await until(async () => (await pending()) === 0)
	expect(received.filter(resource => resource === 'categories').length).toBeGreaterThanOrEqual(4)
})

it('joins the requests of one resource: one delivery per window, then the rest', async () => {
	const purges = service()
	purges.attach(db(), { endpoint, timings })
	for (let n = 0; n < 20; n++) purges.revalidate('products', `prom sync ${n}`)
	await settled()
	await pause(timings.leaseMs)
	// The first request, the rest joined into one after it, each echoed once.
	expect(received.length).toBeGreaterThanOrEqual(2)
	expect(received.length).toBeLessThanOrEqual(4)
	expect(received.every(resource => resource === 'products')).toBe(true)
})

it('delivers what a stopped process left in the outbox', async () => {
	await db()
		.collection(PURGE_OUTBOX)
		.insertOne({
			_id: 'landings' as never,
			triggers: ['typed landing edit'],
			version: 1,
			due_at: new Date(),
			attempts: 0,
			lease_until: null,
			echo: false,
			last_sent_at: null
		})
	service().attach(db(), { endpoint, timings })
	await settled()
	expect(received).toEqual(['landings', 'landings'])
})

it('never sends one purge from two processes', async () => {
	const [first, second] = [service(), service()]
	first.attach(db(), { endpoint, timings })
	second.attach(db(), { endpoint, timings })
	first.revalidate('products', 'typed product edit')
	await settled()
	await pause(timings.leaseMs)
	// The purge and its echo — each once.
	expect(received).toEqual(['products', 'products'])
})
