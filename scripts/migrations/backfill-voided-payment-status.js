/**
 * Migration: backfill payment_status = VOIDED for already-cancelled orders.
 *
 * Orders cancelled before the VOIDED status existed kept payment_status
 * PENDING/FAILED, so they still read "Очікує оплату" in the customer account,
 * the admin panel, reports and the PDF invoice. Paid orders are left untouched —
 * their money really arrived and an admin refunds them manually (REFUNDED).
 *
 * See TD-0003 / docs/architecture/state-machines.md in the fillando-meta repo.
 *
 * Usage:
 *   node scripts/migrations/backfill-voided-payment-status.js --dry-run
 *   node scripts/migrations/backfill-voided-payment-status.js
 */

const mongoose = require('mongoose')
require('dotenv').config()

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}

const DRY_RUN = process.argv.includes('--dry-run')

const FILTER = {
	order_status: 'CANCELLED',
	payment_status: { $in: ['PENDING', 'FAILED'] }
}

async function main() {
	await mongoose.connect(DATABASE_URL)
	console.log('Connected to MongoDB.')

	const collection = mongoose.connection.db.collection('orders')

	const matched = await collection.countDocuments(FILTER)
	console.log(`Cancelled orders with an unpaid payment status: ${matched}`)

	if (DRY_RUN) {
		console.log('Dry run — nothing was written.')
	} else if (matched === 0) {
		console.log('Nothing to backfill.')
	} else {
		const result = await collection.updateMany(FILTER, {
			$set: { payment_status: 'VOIDED' }
		})
		console.log(`Updated ${result.modifiedCount} documents (matched ${result.matchedCount}).`)

		const remaining = await collection.countDocuments(FILTER)
		console.log(`Remaining after backfill: ${remaining} (expected 0).`)
	}

	await mongoose.disconnect()
	console.log('Done.')
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
