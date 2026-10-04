/**
 * Migration: bring stored orders onto the TD-0011 lifecycle.
 *
 *   1. An order that already has a TTN but still reads NEW, PROCESSING or CONFIRMED has shipped
 *      — a TTN is what ships an order now → SHIPPED. Whatever the delivery method: a PICKUP
 *      order with a TTN was posted after all (23 of 39 in the production dump), and the tracker
 *      follows it from here.
 *   2. A *legacy* PROCESSING without a shipment → CONFIRMED. Before TD-0011 «В обробці» meant
 *      «confirmed, being packed»; now it means «buyer contacted, confirmation awaited» and sits
 *      before CONFIRMED. Legacy rows are told apart by their history: the new code records every
 *      move to PROCESSING in `status_history`, a row set under the old meaning has no such entry.
 *   3. DELIVERED + PAID → COMPLETED: «delivered and paid» is COMPLETED by definition.
 *   4. COMPLETED without PAID is only reported, never changed: before TD-0011 an admin could set
 *      COMPLETED by hand, and whether such an order was really paid is for a person to check.
 *   5. DELIVERED cash-on-delivery orders still PENDING are only reported: the tracker now marks a
 *      received COD parcel PAID + COMPLETED itself, but it no longer follows DELIVERED, so these
 *      wait for the admin's «Оплачено» — one click each, which also completes them.
 *
 * Every changed order gets a `status_history` entry (`actor: 'system'`). Each step filters on the
 * state it changes, so re-running is a no-op; there are no transactions (standalone MongoDB) and
 * none are needed — every update is one document's own fields.
 *
 * Run right after the TD-0011 backend is deployed, before the frontend.
 * See fillando-meta docs/designs/TD-0011-order-status-flow.md §7.
 *
 * Usage:
 *   node scripts/migrations/td-0011-order-status-flow.js --dry-run
 *   node scripts/migrations/td-0011-order-status-flow.js
 */

const mongoose = require('mongoose')
require('dotenv').config()

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}

const DRY_RUN = process.argv.includes('--dry-run')
const NOTE = 'TD-0011 migration'

const HAS_TTN = { nova_post_ttn: { $nin: [null, ''] } }

/** Each step: one source status, one target, the filter that still needs it. */
const STEPS = [
	...['NEW', 'PROCESSING', 'CONFIRMED'].map(from => ({
		label: `${from} with a TTN → SHIPPED`,
		from,
		to: 'SHIPPED',
		filter: { order_status: from, ...HAS_TTN }
	})),
	{
		label: 'legacy PROCESSING (old meaning, no history) without a shipment → CONFIRMED',
		from: 'PROCESSING',
		to: 'CONFIRMED',
		// Disjoint from step 1, so the dry-run counts add up to what the real run changes.
		filter: {
			order_status: 'PROCESSING',
			$nor: [HAS_TTN],
			status_history: { $not: { $elemMatch: { field: 'order_status', to: 'PROCESSING' } } }
		}
	},
	{
		label: 'DELIVERED + PAID → COMPLETED',
		from: 'DELIVERED',
		to: 'COMPLETED',
		filter: { order_status: 'DELIVERED', payment_status: 'PAID' }
	}
]

async function main() {
	await mongoose.connect(DATABASE_URL)
	console.log(`Connected to MongoDB.${DRY_RUN ? ' Dry run — nothing will be written.' : ''}`)

	const orders = mongoose.connection.db.collection('orders')

	for (const step of STEPS) {
		const matched = await orders.countDocuments(step.filter)
		console.log(`${step.label}: ${matched}`)
		if (DRY_RUN || matched === 0) continue

		const result = await orders.updateMany(step.filter, {
			$set: { order_status: step.to },
			$push: {
				status_history: {
					field: 'order_status',
					from: step.from,
					to: step.to,
					at: new Date(),
					actor: 'system',
					note: NOTE
				}
			}
		})
		console.log(`  updated ${result.modifiedCount} (matched ${result.matchedCount})`)
	}

	const unpaidCompleted = await orders
		.find(
			{ order_status: 'COMPLETED', payment_status: { $ne: 'PAID' } },
			{ projection: { order_number: 1, payment_method: 1, payment_status: 1 } }
		)
		.toArray()
	console.log(`COMPLETED without PAID (left as is — check by hand): ${unpaidCompleted.length}`)
	for (const order of unpaidCompleted) {
		console.log(`  ${order.order_number}  ${order.payment_method}  ${order.payment_status}`)
	}

	const deliveredCod = await orders
		.find(
			{ order_status: 'DELIVERED', payment_method: 'COD', payment_status: 'PENDING' },
			{ projection: { order_number: 1, nova_post_ttn: 1 } }
		)
		.toArray()
	console.log(
		`DELIVERED cash-on-delivery still PENDING (set «Оплачено» by hand — it completes them): ${deliveredCod.length}`
	)
	for (const order of deliveredCod)
		console.log(`  ${order.order_number}  ТТН ${order.nova_post_ttn}`)

	const processingLeft = await orders.countDocuments({ order_status: 'PROCESSING' })
	console.log(`PROCESSING remaining (new meaning — awaiting confirmation): ${processingLeft}`)

	await mongoose.disconnect()
	console.log('Done.')
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
