/**
 * The weight must never be invented: a variant the planner cannot weigh stays null, and the
 * spool is added only to spooled filament. Everything downstream (delivery estimate, JSON-LD
 * `weight`, `g:shipping_weight`) degrades by absence, so a wrong number here would be worse than
 * none (TD-0006 §5.2).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../scripts/fillando_v_2/backfill-variant-weight.js') as {
	SPOOL_WEIGHT_G: number
	HEAVY_REEL_NET_G: number
	gramsFromText: (text: unknown) => number | null
	parseNetGrams: (input: {
		attributes?: unknown
		productName?: string
		variantName?: string
	}) => { grams: number; source: string } | null
	isRefill: (variant: unknown, productAttributes: unknown) => boolean
	planWeightG: (input: { product: unknown; variant: unknown }) => {
		weight_g: number
		net_g: number
		spool_g: number
		source: string
		note: string | null
	} | null
}

const PRODUCT_NAME = 'Філамент (пластик для 3D принтера) Kingroon PLA Silk 1,75 мм 1 кг'
const WEIGHT_ATTR = { k: 'vaha', l: 'Вага', v: 1 }
const SPOOLED = { k: 'spool_included', l: 'Котушка в комплекті', v: 'Так' }
const REFILL = { k: 'spool_included', l: 'Котушка в комплекті', v: 'Ні (рефіл)' }

describe('gramsFromText', () => {
	it.each([
		['… 1,75 мм 1 кг', 1000],
		['Sunlu PLA 0,5 kg', 500],
		['Refill 250 г', 250],
		['PETG 3 кг (еко-пакування)', 3000]
	])('%s → %d g', (text, grams) => {
		expect(migration.gramsFromText(text)).toBe(grams)
	})

	it('does not mistake the diameter for a weight', () => {
		expect(migration.gramsFromText('Kingroon PLA 1,75 мм')).toBeNull()
	})

	it.each([null, undefined, 42, ''])('returns null for %p', value => {
		expect(migration.gramsFromText(value)).toBeNull()
	})
})

describe('parseNetGrams', () => {
	it('prefers the «Вага» attribute, read as kilograms', () => {
		expect(
			migration.parseNetGrams({ attributes: [WEIGHT_ATTR], productName: 'no weight here' })
		).toEqual({ grams: 1000, source: 'attribute' })
		expect(migration.parseNetGrams({ attributes: [{ ...WEIGHT_ATTR, v: '3' }] })).toEqual({
			grams: 3000,
			source: 'attribute'
		})
	})

	it('reads an attribute over 20 as grams already', () => {
		expect(migration.parseNetGrams({ attributes: [{ ...WEIGHT_ATTR, v: 750 }] })).toEqual({
			grams: 750,
			source: 'attribute'
		})
	})

	it('falls back to the variant name, then the product name', () => {
		expect(
			migration.parseNetGrams({
				attributes: [],
				variantName: 'Kingroon PLA 0,5 кг — Чорний',
				productName: PRODUCT_NAME
			})
		).toEqual({ grams: 500, source: 'variant_name' })
		expect(migration.parseNetGrams({ attributes: [], productName: PRODUCT_NAME })).toEqual({
			grams: 1000,
			source: 'product_name'
		})
	})

	it('returns null rather than guessing', () => {
		expect(migration.parseNetGrams({ attributes: [], productName: 'Kingroon PLA' })).toBeNull()
	})
})

describe('isRefill', () => {
	it('trusts the product attribute first', () => {
		expect(migration.isRefill({ name: 'PETG — Clear' }, [REFILL])).toBe(true)
		expect(migration.isRefill({ name: 'PETG — Clear' }, [SPOOLED])).toBe(false)
	})

	it('recognises the marker in the variant before the refill split has run', () => {
		expect(migration.isRefill({ v_value: 'Clear Безбарвний Refill' }, [SPOOLED])).toBe(true)
		expect(migration.isRefill({ name: 'PETG — Прозорий (рефіл)' }, [])).toBe(true)
	})
})

describe('planWeightG', () => {
	const product = { name: PRODUCT_NAME, attributes: [WEIGHT_ATTR, SPOOLED] }

	it('adds the spool to spooled filament', () => {
		const plan = migration.planWeightG({ product, variant: { name: 'PLA Silk — Gold' } })
		expect(plan).toEqual({
			weight_g: 1000 + migration.SPOOL_WEIGHT_G,
			net_g: 1000,
			spool_g: migration.SPOOL_WEIGHT_G,
			source: 'attribute',
			note: null
		})
	})

	it('ships a refill without the spool', () => {
		const refillProduct = { ...product, attributes: [WEIGHT_ATTR, REFILL] }
		const plan = migration.planWeightG({ product: refillProduct, variant: { name: 'x' } })
		expect(plan?.weight_g).toBe(1000)
		expect(plan?.spool_g).toBe(0)
	})

	it('flags a heavy reel for a manual check instead of inventing a spool weight', () => {
		const heavy = { name: 'PETG 3 кг', attributes: [{ ...WEIGHT_ATTR, v: 3 }, SPOOLED] }
		const plan = migration.planWeightG({ product: heavy, variant: { name: 'x' } })
		expect(plan?.weight_g).toBe(3000 + migration.SPOOL_WEIGHT_G)
		expect(plan?.note).toMatch(/verify in the admin/)
	})

	it('returns null when nothing states the weight', () => {
		const bare = { name: 'Kingroon PLA', attributes: [SPOOLED] }
		expect(
			migration.planWeightG({ product: bare, variant: { name: 'PLA — Black' } })
		).toBeNull()
	})
})
