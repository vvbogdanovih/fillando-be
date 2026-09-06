# Catalogue facets — `GET /products/catalog`

Design: `fillando-meta/docs/designs/TD-0008-catalog-facets-and-filter-ux.md`. Implementation:
`ProductVariantRepository.findCatalogItems` (facet `$facet`), `ProductService.getCatalog`
(facet keys), `src/common/utils/facet.utils.ts` (ordering and merging).

## What a count means

For a dimension `X` and one of its values `v`, `facets[X][].count` is the number of **active
variants of the category** that match every active filter **except the filter on `X`**. So while
`?polymer=PLA` is set, the numbers next to `PETG` and `ABS` answer "how many would I get if I
ticked this too" — the standard facet pattern, and the reason the sidebar never collapses to the
one value the shopper just chose. Price (`price_min/max`) and colour (`color_family`) count as
"other filters" for every attribute dimension; for the colour swatches, colour itself is the
excluded dimension and the attributes and price narrow it.

A value present anywhere in the category stays in the list with `count: 0` when the current
narrowing has none of it. Hiding it would make the URL that selects it unreachable — for the
shopper and for a crawler that has already indexed it.

## Which keys are facets

The keys of the category's `required_attributes`, in the category's order — read by
`getCatalog` from `CategoryRepository.findById`, never taken from the query string. A key with
no matching attribute on any product yields `[]`, not a missing key. An unknown `category_id`
yields empty facets and an empty listing (200), an invalid one is a 400.

## Ordering

`compareFacetValues`: values that are purely numeric (`1.75`, `0.5`, `3`) sort by magnitude and
come first; the rest sort by `Intl.Collator('uk-UA', { numeric: true, sensitivity: 'base' })`,
which puts Cyrillic before Latin. Counts never affect order — a list that reshuffles on each
click is unusable. Units are not part of the value (they live on `required_attributes[].unit`).

## How it is computed

One aggregate: `$match {category_id, status}` (indexed) → `$lookup products` → `$project` down to
`price`, `color_id`, `color_family`, `attributes` → `$facet` with:

- `values` — every `{k, v}` of the facet keys over the whole category;
- `count_<i>` — one branch per facet key, positional so a key can never be an invalid field
  name: `$match` (all filters except this key) → `$unwind attributes` → `$match k` →
  `$group {v, variant}` → `$group v, count`. The two-step group makes the count per variant, so a
  product that lists the same `finish` twice is not counted twice;
- `color_all` — families in the category with the swatch shade (lowest-`order` colour);
- `color_count` — `color_family` counts under all filters except colour.

JS then merges values with counts (`mergeFacetValues`) and families with counts. The listing
and `price_range` are separate aggregates and unchanged: the listing still matches colour and
price before the `$lookup` so `{category_id, status, color_family}` serves it, and the price
bounds are category-wide so the slider does not jump.

The `$project` before `$facet` is load-bearing: `$facet` keeps each branch's input in memory
under a 100 MB stage limit, and product descriptions (HTML) and image lists would be most of
that. With the projection a variant is ~400 bytes; 5 000 variants × ~10 branches stay far below
the limit.

## `filter_options` is deprecated

`filter_options: Record<key, string[]>` is now derived from `facets` (`values.map(v => v.value)`)
and costs no extra query. It stays for one release because the backend and the storefront deploy
as separate services, so a storefront built before this change may briefly read a backend built
after it. Plan-0007 task 15 removes it once the release is accepted; when it goes, update this
file, `API_OPERATION.PRODUCTS.CATALOG` and run `yarn spec:export`.
