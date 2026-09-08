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

## Which values are a value

A value is what the sidebar prints beside the checkbox, so it has to be printable. `Attribute.v`
is `Mixed`, and a required attribute left empty in the admin form is stored as `v: ''` — that
value reaches neither `facets` nor the deprecated `filter_options`. The `values` branch drops it
in Mongo (`$match { '_id.v': { $regex: /\S/ } }`, after the `$toString`) and the merge drops it
again in JS; whitespace-and-nothing-else is the same case. What is **not** dropped is a value
that merely looks falsy: `$toString` turns a numeric `0` and a boolean `false` into `'0'` and
`'false'`, and both stay in the list — `spool_included: false` is an answer, not a blank (I-4).

A blank is a data defect, not a filter, and it is treated as narrowly as that: the product keeps
its place in the listing and keeps counting in its other dimensions — only that one value never
becomes a checkbox with no name.

## The swatch of a colour family

`color_options[].hex_stops` is the emblem of the **family**, not of one colour inside it, so it
may not change shape from request to request. The `color_all` branch returns every dictionary
colour of the family the category actually uses (`$addToSet`), and the representative is chosen
in JS: the lowest `order` — the field the admin sorts the dictionary with — with `name_en`,
unique in the dictionary, as the tiebreaker. The rule is total and reads only the dictionary, so
the same dictionary paints the same swatch whatever order Mongo answers in, whichever narrowing
is active, and whether or not a variant was archived since. Picking the family's most common
colour instead would also be meaningful, and was rejected for exactly that last reason: it
repaints the emblem on every import (I-21). The swatch row is ordered in the same JS pass — by
the representative's `order`, then by family name.

Colour is a dimension everywhere or nowhere: `ProductVariantRepository.countVariantsForLandings`
— the «Товарів» column of the landings admin and the guard that refuses to publish a landing
matching nothing — routes a pinned `color_family` to the variant field, the way `getCatalog`
routes the query parameter. Otherwise both would read 0 for a landing whose page the storefront
fills correctly (I-g).

## How it is computed

One aggregate: `$match {category_id, status}` (indexed) → `$lookup products` → `$project` down to
`price`, `color_id`, `color_family`, `attributes` → `$facet` with:

- `values` — every `{k, v}` of the facet keys over the whole category, blanks excluded;
- `count_<i>` — one branch per facet key, positional so a key can never be an invalid field
  name: `$match` (all filters except this key) → `$unwind attributes` → `$match k` →
  `$group {v, variant}` → `$group v, count`. The two-step group makes the count per variant, so a
  product that lists the same `finish` twice is not counted twice;
- `color_all` — families in the category, each with every dictionary colour that could paint its
  swatch; which one does is decided in JS;
- `color_count` — `color_family` counts under all filters except colour.

JS then merges values with counts (`mergeFacetValues`), and families with counts and with the
swatch their representative gives them. The listing and `price_range` are separate aggregates and
unchanged: the listing still matches colour and price before the `$lookup` so
`{category_id, status, color_family}` serves it, and the price bounds are category-wide so the
slider does not jump.

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
