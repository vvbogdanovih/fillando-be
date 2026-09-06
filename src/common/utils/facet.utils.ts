/**
 * Ordering and shaping of catalogue facet values (TD-0008 §5.4.2).
 *
 * Values are the canonical strings stored in `product.attributes[].v` — `PLA`, `1.75`, `Silk`.
 * They reach the sidebar in the order this module produces, and the same order is used by the
 * chips and by the landings admin, so it lives on the server rather than in three places on the
 * client.
 */

/** One value of a facet dimension and how many variants of the current narrowing carry it. */
export interface CatalogFacetValue {
	value: string
	count: number
}

/** A value that is a number and nothing else. `1 кг` is not — the unit lives on the dimension. */
const NUMERIC = /^-?\d+(\.\d+)?$/

/**
 * `numeric: true` makes `PLA2 < PLA10` inside words too; `sensitivity: 'base'` folds case so
 * `silk` and `Silk` sit together instead of ASCII-sorting upper-case first.
 */
const UK_COLLATOR = new Intl.Collator('uk-UA', { numeric: true, sensitivity: 'base' })

/**
 * Numbers by magnitude first (`0.5 < 1 < 3`, `1.75 < 2.85`), then words by the Ukrainian collator.
 * A stable tiebreaker keeps the order deterministic when the collator considers two strings equal.
 */
export function compareFacetValues(a: string, b: string): number {
	const aNumeric = NUMERIC.test(a)
	const bNumeric = NUMERIC.test(b)
	if (aNumeric && bNumeric) return parseFloat(a) - parseFloat(b) || plainCompare(a, b)
	if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
	return UK_COLLATOR.compare(a, b) || plainCompare(a, b)
}

function plainCompare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Joins the full value list of a dimension (computed over the whole category) with the counts of
 * the current narrowing. A value absent from `counts` is kept with `0`: hiding it would make the
 * URL state that selects it unreachable, both for the shopper and for a crawler that already
 * indexed it. Empty strings are dropped, as the old `filter_options` did, and duplicates collapse.
 */
export function mergeFacetValues(
	values: Iterable<string>,
	counts: ReadonlyMap<string, number>
): CatalogFacetValue[] {
	const unique = new Set<string>()
	for (const value of values) {
		if (value) unique.add(value)
	}
	return [...unique]
		.sort(compareFacetValues)
		.map(value => ({ value, count: counts.get(value) ?? 0 }))
}
