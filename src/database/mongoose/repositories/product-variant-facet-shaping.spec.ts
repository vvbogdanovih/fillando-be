import { Types } from 'mongoose'
import { ColorFamily } from 'src/common/types/enums'
import { ProductVariantRepository } from './product-variant.repository'

/**
 * The half of the facet payload that is decided in JS, and the two `$match`es that decide the
 * rest — driven by a model that answers each `aggregate` with canned rows, so the rules hold
 * without a database (the aggregation itself stays covered by the `*.int-spec.ts` files).
 *
 * Three rules live here:
 *
 * - a blank attribute value is not a value of its dimension (I-4) — a product saved with a
 *   required attribute left empty carries `v: ''`, and the sidebar must not draw a checkbox
 *   with a count and no name;
 * - the swatch of a colour family is the emblem of the FAMILY, so it is chosen by a rule over
 *   the dictionary and never by whichever colour Mongo returned first (I-21);
 * - a landing's pinned `color_family` is matched where colour actually lives — on the variant —
 *   so the admin's «Товарів» column and the publish guard agree with the storefront (I-g).
 */
type Pipeline = Record<string, any>[]

/** One dictionary colour a family's swatch could be painted from, as `color_all` returns it. */
type SwatchCandidate = { order: number; name_en: string; hex_stops: string[] }

const CATEGORY_ID = new Types.ObjectId().toString()
const FACET_KEYS = ['diameter', 'spool_included', 'vaha']

const fakeModel = (answer: (pipeline: Pipeline) => unknown[]) => {
	const pipelines: Pipeline[] = []
	const aggregate = jest.fn((pipeline: Pipeline) => {
		pipelines.push(pipeline)
		return { exec: () => Promise.resolve(answer(pipeline)) }
	})
	return { pipelines, model: { aggregate } }
}

const facetOf = (pipeline: Pipeline): Record<string, Pipeline> | null => {
	const stage = pipeline.find(s => '$facet' in s)
	return stage ? (stage.$facet as Record<string, Pipeline>) : null
}

/**
 * `findCatalogItems` fires three aggregates at once — the listing, the category-wide price
 * range and the facet pass. Only the last one matters here; the other two get an empty answer
 * of the right shape.
 */
const runCatalog = async (rows: Record<string, unknown[]>, facetKeys = FACET_KEYS) => {
	const { pipelines, model } = fakeModel(pipeline => {
		const branches = facetOf(pipeline)
		if (branches && 'values' in branches) return [rows]
		if (branches && 'items' in branches) return [{ items: [], meta: [{ total: 0 }] }]
		return [{ min: 0, max: 0 }]
	})
	const repo = new ProductVariantRepository(model as never)
	const result = await repo.findCatalogItems({
		category_id: CATEGORY_ID,
		page: 1,
		limit: 20,
		sort: 'newest',
		attrFilters: {},
		facetKeys
	})
	const facetPipeline = pipelines.find(p => facetOf(p) && 'values' in facetOf(p)!)
	return { result, branches: facetOf(facetPipeline ?? [])! }
}

describe('ProductVariantRepository.findCatalogItems — a blank attribute value is not a filter', () => {
	const rows = {
		values: [
			{ _id: { k: 'diameter', v: '1.75' } },
			// A product saved through the admin with «Діаметр» left empty.
			{ _id: { k: 'diameter', v: '' } },
			{ _id: { k: 'diameter', v: '   ' } },
			{ _id: { k: 'diameter', v: '\t\n' } },
			// Legal values that merely look falsy once stringified.
			{ _id: { k: 'spool_included', v: 'false' } },
			{ _id: { k: 'vaha', v: '0' } }
		],
		count_0: [
			{ _id: '1.75', count: 4 },
			{ _id: '', count: 2 }
		],
		count_1: [{ _id: 'false', count: 3 }],
		count_2: [{ _id: '0', count: 1 }],
		color_all: [],
		color_count: []
	}

	it('keeps blank and whitespace-only values out of the dimension', async () => {
		const { result } = await runCatalog(rows)

		expect(result.facets.diameter).toEqual([{ value: '1.75', count: 4 }])
	})

	it('keeps them out of the deprecated filter_options too', async () => {
		const { result } = await runCatalog(rows)

		expect(result.filter_options).toEqual({
			diameter: ['1.75'],
			spool_included: ['false'],
			vaha: ['0']
		})
	})

	it('keeps a legal «0» and «false» — those are values, not blanks', async () => {
		const { result } = await runCatalog(rows)

		expect(result.facets.spool_included).toEqual([{ value: 'false', count: 3 }])
		expect(result.facets.vaha).toEqual([{ value: '0', count: 1 }])
	})

	it('asks Mongo to drop them as well, so a blank never reaches the merge', async () => {
		const { branches } = await runCatalog(rows)
		const values = branches.values

		expect(values[values.length - 1]).toEqual({ $match: { '_id.v': { $regex: /\S/ } } })
	})
})

describe('ProductVariantRepository.findCatalogItems — the colour family emblem is stable', () => {
	// Two families whose lowest `order` is not the entry that would sort first by name, and
	// one exact `order` tie — the case that used to depend on the document order.
	const gold: SwatchCandidate[] = [
		{ order: 20, name_en: 'Gold', hex_stops: ['#d4af37'] },
		{ order: 20, name_en: 'Champagne Gold', hex_stops: ['#f6e6a8', '#c9a227'] },
		{ order: 8, name_en: 'Antique Gold', hex_stops: ['#8c6d1f'] }
	]
	const black: SwatchCandidate[] = [
		{ order: 1, name_en: 'Black', hex_stops: ['#111418'] },
		{ order: 1, name_en: 'Basalt Black', hex_stops: ['#1f2933'] }
	]

	const rowsFor = (families: Array<[ColorFamily, SwatchCandidate[]]>) => ({
		values: [],
		color_all: families.map(([family, candidates]) => ({ _id: family, candidates })),
		color_count: [
			{ _id: ColorFamily.GOLD, count: 3 },
			{ _id: ColorFamily.BLACK, count: 7 }
		]
	})

	const rotate = <T>(list: T[]): T[] => [...list.slice(1), list[0]]

	it('paints a family from its lowest-order colour, with name_en breaking the tie', async () => {
		const { result } = await runCatalog(
			rowsFor([
				[ColorFamily.GOLD, gold],
				[ColorFamily.BLACK, black]
			]),
			[]
		)

		expect(result.color_options).toEqual([
			// order 1, and «Basalt Black» before «Black» at the same order.
			{ family: ColorFamily.BLACK, count: 7, hex_stops: ['#1f2933'] },
			// «Antique Gold» at order 8 wins over the two at 20.
			{ family: ColorFamily.GOLD, count: 3, hex_stops: ['#8c6d1f'] }
		])
	})

	it('answers the same whatever order the colours and families arrive in', async () => {
		const straight = await runCatalog(
			rowsFor([
				[ColorFamily.GOLD, gold],
				[ColorFamily.BLACK, black]
			]),
			[]
		)
		const shuffled = await runCatalog(
			rowsFor([
				[ColorFamily.BLACK, [...black].reverse()],
				[ColorFamily.GOLD, rotate(gold)]
			]),
			[]
		)

		expect(shuffled.result.color_options).toEqual(straight.result.color_options)
	})

	it('asks Mongo for every candidate of the family rather than for one of them', async () => {
		const { branches } = await runCatalog(rowsFor([[ColorFamily.GOLD, gold]]), [])
		const group = branches.color_all.find(stage => '$group' in stage) as
			| { $group: Record<string, unknown> }
			| undefined

		expect(group?.$group.candidates).toHaveProperty('$addToSet')
		expect(branches.color_all.some(stage => '$sort' in stage)).toBe(false)
	})
})

describe('ProductVariantRepository.countVariantsForLandings — a pinned colour', () => {
	const LANDING_ID = '6712b0a1c2d3e4f5a6b7c8d9'
	const categoryId = new Types.ObjectId()

	const runCount = async (filters: Record<string, string[]>) => {
		const { pipelines, model } = fakeModel(() => [{ [`l_${LANDING_ID}`]: [{ n: 5 }] }])
		const repo = new ProductVariantRepository(model as never)
		const counts = await repo.countVariantsForLandings([
			{ id: LANDING_ID, category_id: categoryId, filters }
		])
		const branch = facetOf(pipelines[0])![`l_${LANDING_ID}`]
		const match = branch[0] as { $match: { $and: unknown[] } }
		return { counts, conditions: match.$match.$and }
	}

	it('matches a pinned color_family on the variant, never through product.attributes', async () => {
		const { conditions, counts } = await runCount({ color_family: ['gold', 'white'] })

		// One `$in` — within a dimension the filter is an OR, exactly as the catalogue query has it.
		expect(conditions).toEqual([
			{ category_id: categoryId },
			{ color_family: { $in: ['gold', 'white'] } }
		])
		expect(counts.get(LANDING_ID)).toBe(5)
	})

	it('ANDs the colour dimension with the attribute ones', async () => {
		const { conditions } = await runCount({ polymer: ['PLA'], color_family: ['gold'] })

		expect(conditions).toEqual([
			{ category_id: categoryId },
			{ 'product.attributes': { $elemMatch: { k: 'polymer', v: { $in: ['PLA'] } } } },
			{ color_family: { $in: ['gold'] } }
		])
	})

	it('leaves an ordinary attribute key where it was', async () => {
		const { conditions } = await runCount({ finish: ['Silk', 'Matte'] })

		expect(conditions).toEqual([
			{ category_id: categoryId },
			{ 'product.attributes': { $elemMatch: { k: 'finish', v: { $in: ['Silk', 'Matte'] } } } }
		])
	})

	it('ignores a dimension pinned with no values, colour included', async () => {
		const { conditions } = await runCount({ color_family: [], polymer: [] })

		expect(conditions).toEqual([{ category_id: categoryId }])
	})
})
