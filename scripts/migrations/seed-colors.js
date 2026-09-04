/**
 * Seed: the colour dictionary (TD-0002 §5.2.2).
 *
 * One row per canonical manufacturer colour. `name_en` is the key the normalizer matches on,
 * `name_uk` is what a shopper reads, `family` is the swatch bucket the catalogue filters by,
 * and `hex_stops` paints the swatch — one stop is a solid circle, several a gradient, and a
 * `multicolor` family is drawn as a conic gradient so a rainbow reads as a ring.
 *
 * `synonyms` are extra spellings seen in the existing `v_value` data. The normalizer also
 * derives aliases automatically (`name_en`, `name_uk`, and `"name_en name_uk"`, which is how
 * this shop's imported variants are usually written), so only the irregular spellings are
 * listed here.
 *
 * Deliberately conservative: this covers the colours that can be identified with certainty.
 * Codes and marketing names (`TR-1`, `HC186`, `Macaron`, `Universe`) are NOT guessed at — they
 * land in color-report.json for a human to decide on, which is what the plan asks for.
 *
 * Non-destructive and idempotent: an existing colour (matched on `name_en`) is left untouched,
 * so a hex tweaked in the admin survives a re-run.
 *
 * Usage:
 *   node scripts/migrations/seed-colors.js --dry-run
 *   node scripts/migrations/seed-colors.js
 */

const mongoose = require('mongoose')

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * @typedef {{ name_en: string, name_uk: string, family: string, hex_stops: string[], synonyms?: string[] }} ColorSeed
 * @type {ColorSeed[]}
 */
const COLORS = [
	{ name_en: 'Black', name_uk: 'Чорний', family: 'black', hex_stops: ['#1a1a1a'] },
	{
		name_en: 'Charcoal',
		name_uk: 'Вугільно-чорний',
		family: 'black',
		hex_stops: ['#36454f'],
		synonyms: ['Charcoal Вугільно-чорний']
	},
	{ name_en: 'White', name_uk: 'Білий', family: 'white', hex_stops: ['#f5f5f5'] },
	{
		name_en: 'Bone White',
		name_uk: 'Кістково-білий',
		family: 'white',
		hex_stops: ['#e3dac9'],
		synonyms: ['Кістково-білий']
	},
	{ name_en: 'Beige', name_uk: 'Бежевий', family: 'brown', hex_stops: ['#e8d8b8'] },
	{
		name_en: 'Gray',
		name_uk: 'Сірий',
		family: 'gray',
		hex_stops: ['#808080'],
		synonyms: ['Grey']
	},
	{ name_en: 'Dark Gray', name_uk: 'Темно-сірий', family: 'gray', hex_stops: ['#4a4a4a'] },
	{ name_en: 'Ash Gray', name_uk: 'Попелясто-сірий', family: 'gray', hex_stops: ['#b2beb5'] },
	{ name_en: 'Titan Gray', name_uk: 'Сірий титан', family: 'gray', hex_stops: ['#878681'] },
	{ name_en: 'Lava Gray', name_uk: 'Лавово-сірий', family: 'gray', hex_stops: ['#6e6e6e'] },
	{ name_en: 'Red', name_uk: 'Червоний', family: 'red', hex_stops: ['#e53e3e'] },
	{
		name_en: 'Burgundy Red',
		name_uk: 'Бордовий',
		family: 'red',
		hex_stops: ['#800020'],
		synonyms: ['Вишнево-червоний', 'Вишня']
	},
	{ name_en: 'Orange', name_uk: 'Помаранчевий', family: 'orange', hex_stops: ['#ed8936'] },
	{
		name_en: 'Sunflower',
		name_uk: 'Соняшниковий',
		family: 'yellow',
		hex_stops: ['#ffc300'],
		synonyms: ['Сонячно-помаранчевий']
	},
	{ name_en: 'Yellow', name_uk: 'Жовтий', family: 'yellow', hex_stops: ['#ecc94b'] },
	{
		name_en: 'Lemon Yellow',
		name_uk: 'Лимонно-жовтий',
		family: 'yellow',
		hex_stops: ['#fff44f'],
		synonyms: ['Яскраво-жовтий']
	},
	{
		name_en: 'Tangerine Yellow',
		name_uk: 'Мандариново-жовтий',
		family: 'yellow',
		hex_stops: ['#ffcc00']
	},
	{ name_en: 'Green', name_uk: 'Зелений', family: 'green', hex_stops: ['#38a169'] },
	{ name_en: 'Dark Green', name_uk: 'Темно-зелений', family: 'green', hex_stops: ['#14532d'] },
	{
		name_en: 'Olive',
		name_uk: 'Оливковий',
		family: 'green',
		hex_stops: ['#808000'],
		synonyms: ['Оливково-зелений']
	},
	{
		name_en: 'Matcha Green',
		name_uk: 'Зелений матча',
		family: 'green',
		hex_stops: ['#8fbc8f'],
		synonyms: ['Трав’яний зелений']
	},
	{
		name_en: 'Mint',
		name_uk: 'М’ятний',
		family: 'green',
		hex_stops: ['#98ff98'],
		synonyms: ['М’ятно-зелений']
	},
	{ name_en: 'Apple Green', name_uk: 'Яблучно-зелений', family: 'green', hex_stops: ['#8db600'] },
	{ name_en: 'Blue', name_uk: 'Синій', family: 'blue', hex_stops: ['#3182ce'] },
	{
		name_en: 'Dark Blue',
		name_uk: 'Темно-синій',
		family: 'blue',
		hex_stops: ['#1e3a8a'],
		synonyms: ['Navy Blue Темно-синій', 'Темно синій', 'Опівнічний (темно-синій)']
	},
	{
		name_en: 'Royal Blue',
		name_uk: 'Королівський синій',
		family: 'blue',
		hex_stops: ['#4169e1']
	},
	{ name_en: 'Jeans Blue', name_uk: 'Джинсовий синій', family: 'blue', hex_stops: ['#5d76a9'] },
	{ name_en: 'Klein Blue', name_uk: 'Синій Кляйна', family: 'blue', hex_stops: ['#002fa7'] },
	{
		name_en: 'Cyan',
		name_uk: 'Блакитний',
		family: 'blue',
		hex_stops: ['#00b7eb'],
		synonyms: ['Небесно-блакитний', 'Blue Grey Сіро-блакитний']
	},
	{ name_en: 'Azure', name_uk: 'Лазуровий', family: 'blue', hex_stops: ['#007fff'] },
	{
		name_en: 'Teal',
		name_uk: 'Бірюзовий',
		family: 'blue',
		hex_stops: ['#008080'],
		synonyms: ['Tea Бірюзовий', 'Синьо-зелений']
	},
	{ name_en: 'Purple', name_uk: 'Фіолетовий', family: 'purple', hex_stops: ['#805ad5'] },
	{
		name_en: 'Iris Purple',
		name_uk: 'Фіолетовий ірис',
		family: 'purple',
		hex_stops: ['#5a4fcf'],
		synonyms: ['Бузкво-фіолетовий', 'Лавандово-фіолетовий', 'Синьо-фіолетовий']
	},
	{
		name_en: 'Magenta',
		name_uk: 'Пурпуровий (маджента)',
		family: 'pink',
		hex_stops: ['#ff00ff']
	},
	{ name_en: 'Pink', name_uk: 'Рожевий', family: 'pink', hex_stops: ['#ed64a6'] },
	{ name_en: 'Sakura Pink', name_uk: 'Рожева сакура', family: 'pink', hex_stops: ['#ffb7c5'] },
	{ name_en: 'Skin', name_uk: 'Тілесний', family: 'brown', hex_stops: ['#e8beac'] },
	{ name_en: 'Brown', name_uk: 'Коричневий', family: 'brown', hex_stops: ['#8b5e3c'] },
	{
		name_en: 'Dark Brown',
		name_uk: 'Темно-коричневий',
		family: 'brown',
		hex_stops: ['#4b3621'],
		synonyms: ['Каштановий']
	},
	{
		name_en: 'Light Brown',
		name_uk: 'Світло-коричневий',
		family: 'brown',
		hex_stops: ['#b5651d']
	},
	{
		name_en: 'Coffee',
		name_uk: 'Кавовий',
		family: 'brown',
		hex_stops: ['#6f4e37'],
		synonyms: ['Кавово-коричневий']
	},
	{ name_en: 'Chocolate', name_uk: 'Шоколадний', family: 'brown', hex_stops: ['#7b3f00'] },
	{ name_en: 'Walnut', name_uk: 'Горіх', family: 'brown', hex_stops: ['#5c4033'] },
	{ name_en: 'Oak', name_uk: 'Дубовий', family: 'brown', hex_stops: ['#c8a165'] },
	{ name_en: 'Maple', name_uk: 'Клен', family: 'brown', hex_stops: ['#d9a066'] },
	{ name_en: 'Gold', name_uk: 'Золотий', family: 'gold', hex_stops: ['#d4af37'] },
	{ name_en: 'Rose Gold', name_uk: 'Рожеве золото', family: 'gold', hex_stops: ['#b76e79'] },
	{ name_en: 'Champagne', name_uk: 'Шампань', family: 'gold', hex_stops: ['#f7e7ce'] },
	{ name_en: 'Bronze', name_uk: 'Бронзовий', family: 'gold', hex_stops: ['#cd7f32'] },
	{
		name_en: 'Copper',
		name_uk: 'Мідний',
		family: 'gold',
		hex_stops: ['#b87333'],
		synonyms: ['Металік мідний']
	},
	{
		name_en: 'Silver',
		name_uk: 'Сріблястий',
		family: 'silver',
		hex_stops: ['#c0c0c0'],
		synonyms: ['Срібний', 'Металік сріблястий']
	},
	{
		name_en: 'Clear',
		name_uk: 'Безбарвний',
		family: 'transparent',
		hex_stops: ['#e8f4f8'],
		synonyms: ['Прозорий']
	},
	// Multi-colour: `hex_stops` order is what the conic swatch is painted from.
	{
		name_en: 'Rainbow',
		name_uk: 'Веселка',
		family: 'multicolor',
		hex_stops: ['#e53e3e', '#ecc94b', '#38a169', '#3182ce', '#805ad5'],
		synonyms: ['Веселковий']
	}
]

/** Normalization shared with normalize-variant-colors.js. */
function normalizeColorValue(value) {
	if (typeof value !== 'string') return null
	const cleaned = value
		.normalize('NFC')
		// The data mixes typographic and straight apostrophes for the same word
		// ("М’ятний" / "М'ятний"), and the dash forms differ too.
		.replace(/[\u2018\u2019\u02BC\u02B9`´]/g, "'")
		.replace(/[\u2010-\u2015]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\s*\brefill\b\s*$/i, '')
		.replace(/^\s*(колір|кольор|цвет|color)\s*[:\-]?\s*/i, '')
		.trim()
	return cleaned === '' ? null : cleaned
}

/** Every spelling that resolves to a colour, lower-cased. */
function aliasesFor(color) {
	const en = color.name_en
	const uk = color.name_uk
	return [en, uk, `${en} ${uk}`, `${uk} ${en}`, ...(color.synonyms ?? [])]
		.map(a => normalizeColorValue(a))
		.filter(Boolean)
		.map(a => a.toLowerCase())
}

/** @returns Map<alias, name_en> — throws if two colours claim the same spelling. */
function buildAliasIndex(colors) {
	const index = new Map()
	for (const color of colors) {
		for (const alias of aliasesFor(color)) {
			const owner = index.get(alias)
			if (owner && owner !== color.name_en) {
				throw new Error(
					`Alias "${alias}" is claimed by both "${owner}" and "${color.name_en}"`
				)
			}
			index.set(alias, color.name_en)
		}
	}
	return index
}

function slugFor(nameEn) {
	return nameEn
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
}

async function migrate(db) {
	const colors = db.collection('colors')

	// Fails loudly rather than seeding a dictionary two spellings disagree about.
	buildAliasIndex(COLORS)

	const existing = await colors.find({}).project({ name_en: 1 }).toArray()
	const existingNames = new Set(existing.map(c => c.name_en))

	const toInsert = COLORS.filter(c => !existingNames.has(c.name_en)).map((c, index) => ({
		name_en: c.name_en,
		name_uk: c.name_uk,
		slug: slugFor(c.name_en),
		family: c.family,
		hex_stops: c.hex_stops.map(h => h.toLowerCase()),
		order: existingNames.size + index,
		createdAt: new Date(),
		updatedAt: new Date()
	}))

	console.log(`Dictionary: ${COLORS.length} defined, ${existingNames.size} already stored.`)
	const byFamily = new Map()
	for (const c of COLORS) byFamily.set(c.family, (byFamily.get(c.family) ?? 0) + 1)
	console.log('By family:', [...byFamily].map(([f, n]) => `${f}=${n}`).join(', '))

	if (toInsert.length === 0) {
		console.log('\nNothing to do.')
		return true
	}

	console.log(`\nPlan: insert ${toInsert.length} colour(s).`)
	for (const c of toInsert) console.log(`  + ${c.name_en} (${c.name_uk}) — ${c.family}`)

	if (DRY_RUN) {
		console.log('\nDry run complete — nothing was changed.')
		return true
	}

	const res = await colors.insertMany(toInsert, { ordered: false })
	console.log(`\nInserted ${res.insertedCount} colour(s).`)

	const total = await colors.countDocuments()
	console.log('\nVerify:')
	const ok = total >= COLORS.length
	console.log(`  ${ok ? 'OK ' : 'FAIL'} colours stored: ${total} (expected ≥ ${COLORS.length})`)
	if (ok) console.log('\nDone. Next: normalize-variant-colors.js --dry-run')
	return ok
}

async function main() {
	require('dotenv').config()
	const DATABASE_URL = process.env.DATABASE_URL
	if (!DATABASE_URL) {
		console.error('DATABASE_URL is not set. Check your .env file.')
		process.exit(1)
	}

	await mongoose.connect(DATABASE_URL)
	let ok = false
	try {
		const db = mongoose.connection.db
		console.log(
			`Connected to MongoDB: database "${db.databaseName}" on ${mongoose.connection.host}.${DRY_RUN ? ' (dry run)' : ''}`
		)
		ok = await migrate(db)
	} finally {
		await mongoose.disconnect()
	}

	if (!ok) process.exit(1)
}

module.exports = { COLORS, normalizeColorValue, aliasesFor, buildAliasIndex, slugFor }

if (require.main === module) {
	main().catch(err => {
		console.error('Fatal:', err.message || err)
		process.exit(1)
	})
}
