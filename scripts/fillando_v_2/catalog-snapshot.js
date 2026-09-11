/** Deterministic catalogue snapshot for dry-run and convergence checks, including BSON types. */
const fs = require('node:fs')
const mongoose = require('mongoose')
const COLLECTIONS = ['categories', 'vendors', 'products', 'product_variants', 'colors', 'landings']
async function snapshot(db) {
	const result = {}
	for (const name of COLLECTIONS)
		result[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray()
	return mongoose.mongo.BSON.EJSON.stringify(result, { relaxed: false })
}
async function main() {
	// No dotenv fallback: the rehearsal must provide its target explicitly.
	if (!process.env.DATABASE_URL || !process.argv[2])
		throw new Error('DATABASE_URL and output path required')
	await mongoose.connect(process.env.DATABASE_URL)
	try {
		fs.writeFileSync(process.argv[2], await snapshot(mongoose.connection.db))
	} finally {
		await mongoose.disconnect()
	}
}
module.exports = { COLLECTIONS, snapshot }
if (require.main === module)
	main().catch(err => {
		console.error(err.message)
		process.exitCode = 1
	})
