/**
 * Migration: add price_updated_at and stock_updated_at fields to product_variants.
 *
 * Sets both fields to null for all existing documents that don't have them yet.
 *
 * Usage:
 *   node scripts/migrations/add-variant-timestamps.js
 */

const mongoose = require('mongoose')
require('dotenv').config()

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL is not set. Check your .env file.')
	process.exit(1)
}

async function main() {
	await mongoose.connect(DATABASE_URL)
	console.log('Connected to MongoDB.')

	const db = mongoose.connection.db
	const collection = db.collection('product_variants')

	const result = await collection.updateMany(
		{
			$or: [
				{ price_updated_at: { $exists: false } },
				{ stock_updated_at: { $exists: false } }
			]
		},
		{ $set: { price_updated_at: null, stock_updated_at: null } }
	)

	console.log(`Updated ${result.modifiedCount} documents (matched ${result.matchedCount}).`)

	await mongoose.disconnect()
	console.log('Done.')
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
