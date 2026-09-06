/**
 * Pulls the shop's real Nova Poshta tariff for the two parcel tiers × two zones the storefront
 * quotes (TD-0006 §5.4), and writes them to `scripts/shipping-rates.json`.
 *
 * The frontend constant `SHIPPING_RATE_TABLE` (fillando-fe, `common/utils/shipping.utils.ts`)
 * and the account-level shipping in Merchant Center are both filled from this file, so the
 * three surfaces cannot disagree. Rerun when the contract changes; never edit the numbers by hand.
 *
 * Read-only against Nova Poshta: `InternetDocument.getDocumentPrice` calculates a price and
 * creates nothing. Uses the same API key as the city/warehouse sync (`NOVA_POS_API_KEY`).
 *
 * Usage:
 *   node scripts/shipping-rates.js            # write scripts/shipping-rates.json
 *   node scripts/shipping-rates.js --dry-run  # print, write nothing
 */

const fs = require('node:fs')
const path = require('node:path')
const axios = require('axios')

const DRY_RUN = process.argv.includes('--dry-run')
const OUT = path.join(__dirname, 'shipping-rates.json')

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/'

/** The shop ships from Lviv (fillando-fe `contacts.constants.ts`: «79000, м. Львів»). */
const SENDER_CITY = 'Львів'
/** "По Україні" is quoted to the capital — the destination most parcels go to. */
const UKRAINE_CITY = 'Київ'
/** Tiers of the "Стандарт" warehouse-to-warehouse tariff the storefront table has. */
const TIER_WEIGHTS_KG = [2, 10]
/** Declared value the insurance fee is computed from — a typical spool order. */
const DECLARED_VALUE_UAH = 600
const SERVICE_TYPE = 'WarehouseWarehouse'
const CARGO_TYPE = 'Parcel'

async function np(apiKey, modelName, calledMethod, methodProperties) {
	const { data } = await axios.post(
		NP_API_URL,
		{ apiKey, modelName, calledMethod, methodProperties },
		{ timeout: 15000 }
	)
	if (!data || !data.success) {
		const errors = (data && data.errors) || ['unknown error']
		throw new Error(`${modelName}.${calledMethod}: ${errors.join('; ')}`)
	}
	return data.data
}

async function cityRef(apiKey, name) {
	const cities = await np(apiKey, 'Address', 'getCities', { FindByString: name, Limit: '20' })
	const exact = cities.find(c => c.Description === name) || cities[0]
	if (!exact) throw new Error(`City "${name}" not found`)
	return { ref: exact.Ref, description: exact.Description, area: exact.AreaDescription }
}

async function price(apiKey, senderRef, recipientRef, weightKg) {
	const rows = await np(apiKey, 'InternetDocument', 'getDocumentPrice', {
		CitySender: senderRef,
		CityRecipient: recipientRef,
		Weight: String(weightKg),
		ServiceType: SERVICE_TYPE,
		Cost: String(DECLARED_VALUE_UAH),
		CargoType: CARGO_TYPE,
		SeatsAmount: '1'
	})
	const row = rows[0]
	if (!row || row.Cost === undefined) throw new Error('getDocumentPrice returned no Cost')
	return { cost: Number(row.Cost), assessed: Number(row.AssessedCost ?? 0), raw: row }
}

async function main() {
	require('dotenv').config({ quiet: true })
	const apiKey = process.env.NOVA_POS_API_KEY
	if (!apiKey) {
		console.error('NOVA_POS_API_KEY is not set. Check your .env file.')
		process.exit(1)
	}

	const sender = await cityRef(apiKey, SENDER_CITY)
	const ukraine = await cityRef(apiKey, UKRAINE_CITY)
	console.log(`Sender: ${sender.description} (${sender.area}) — ${sender.ref}`)
	console.log(`"По Україні" quoted to: ${ukraine.description} — ${ukraine.ref}`)

	const tiers = []
	const raw = {}
	for (const kg of TIER_WEIGHTS_KG) {
		const city = await price(apiKey, sender.ref, sender.ref, kg)
		const country = await price(apiKey, sender.ref, ukraine.ref, kg)
		tiers.push({ max_weight_g: kg * 1000, city_uah: city.cost, ukraine_uah: country.cost })
		raw[`${kg}kg`] = { city: city.raw, ukraine: country.raw }
		console.log(`до ${kg} кг: по місту ₴${city.cost}, по Україні ₴${country.cost}`)
	}

	const result = {
		generated_at: new Date().toISOString().slice(0, 10),
		source: 'nova-post-api',
		method: 'InternetDocument.getDocumentPrice',
		service_type: SERVICE_TYPE,
		cargo_type: CARGO_TYPE,
		declared_value_uah: DECLARED_VALUE_UAH,
		sender_city: sender.description,
		ukraine_city: ukraine.description,
		tiers,
		raw
	}

	if (DRY_RUN) {
		console.log(
			'\nDry run — nothing written.\n' +
				JSON.stringify({ ...result, raw: undefined }, null, 2)
		)
		return
	}
	fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
	console.log(`\nWritten: ${OUT}`)
	console.log(
		'Now paste `tiers` into fillando-fe src/common/utils/shipping.utils.ts (SHIPPING_RATE_TABLE)\n' +
			'and enter the same numbers as account-level shipping in Merchant Center.'
	)
}

main().catch(err => {
	console.error('Fatal:', err.message || err)
	process.exit(1)
})
