# Price Sheet (variants by category)

## Overview

A paginated list of **all active product variants** for the public "price sheet" page, so anyone can
quickly review the whole catalog — **one category after another, each with its own columns** (owner,
2026-11-06: «будувати прайси відповідно до категорій… ті, по яких іде фільтр + те, що було про
наявність»): name, the characteristics the catalogue filters the category by, article, price,
availability, last availability sync. Distinct from `GET /products` (grouped, admin-only) and `catalog`/`search`
(storefront projections that omit these fields).

It is a **public projection**: the response is built from a fixed allowlist of fields and never
carries supplier identifiers or Prom pricing internals — see
[Public projection](#public-projection).

## Endpoint

### `GET /products/price-sheet`

**Auth:** public (no guard).

**Query** (`GetPriceSheetQueryDto`): `q?` (search), `page?=1`, `limit?=50` (max 200).

**Visibility:** only variants with `status = active` (`ProductStatus.ACTIVE`). The aggregation
starts with `{ $match: { status: ProductStatus.ACTIVE } }`, so `draft` and `archived` variants are
neither listed nor counted in `total`, and `q` cannot be used to discover them.

**Sorting:** by **category** first (`category_id`, i.e. creation order — the page shows each category
as its own section), then availability — **in-stock variants before out-of-stock** (`_hasStock`). Within
each availability bucket, variants are **grouped by parent product** (by product name, then product
id) so a product's variants stay together and don't scatter when they were added at different times,
then by variant name. Fixed server-side. (A product with mixed availability therefore has its
in-stock variants in the top bucket and its out-of-stock ones in the bottom bucket — by design,
since in-stock items must come first.)

**Search (`q`):** case-insensitive regex over `product.name`, `sku` and `product.attributes.v`
(substring rather than `$text`). The supplier article (`vendor_product_sku`) is **deliberately not
searchable** — matching on it would let anyone probe supplier identifiers by prefix even though the
field itself is never returned.

**Response:**

```jsonc
{
	"items": [
		{
			"id": "…", // variant id (used for add-to-cart)
			"slug": "…", // variant slug (cart line / product link)
			"image": "https://… | null", // first variant image
			"name": "…", // base product name
			"category_id": "…", // its section; the columns are in `categories`
			"values": { "polymer": "PLA", "vaha": "1 кг", "color": "Чорний (Black)" }, // per column key
			"manufacturer": "SUNLU | null",
			"material": "PLA | null", // deprecated: v1 label match, null for a typed category
			"color": "Червоний | null",
			"variant_label": "63 А | null", // display value; colour remains a separate field
			"article": "FL-000123 | null", // internal system sku
			"price": 1235,
			"sale_price": null,
			"promo_percent": null,
			"promo_ends_at": null,
			"in_stock": true,
			"stock": 48, // available quantity
			"synced_at": "ISO | null" // stock_updated_at
		}
	],
	// The categories of this page's rows, in row order, with their columns.
	"categories": [
		{
			"id": "…",
			"name": "Філамент",
			"columns": [{ "key": "polymer", "label": "Тип пластику" }],
			"variant_column": false // true: a variation no column shows (v1, an axis that is not a filter)
		}
	],
	"total": 1234,
	"page": 1,
	"limit": 50
}
```

**Columns** (`priceColumnsOf`, `src/modules/product/price-columns.ts`, shared with the admin PDF):
every definition of the category with a filter, plus the colour (`semantic: color`, which the
catalogue filters by dictionary family), in the category's order. A column is listed even while all
products share one value («Діаметр» 1.75 — owner: tomorrow's product may differ). **Values**
(`priceValuesOf`): the label and unit («1.75 мм», «Шовковий (Silk)»), several values joined by «, »,
the SKU's own value for its axis (a colour axis as the dictionary names it). A v1 category has no
columns until it is migrated: its rows show the common columns only. «Назва» is the product's name,
so a variation no column shows (a v1 category, an axis that is not a filter) sets `variant_column`
and the page keeps a «Варіант» column (`variant_label ?? color`) for that category.

## Public projection

The pipeline's `$project` stage is the constant `PRICE_SHEET_PUBLIC_PROJECTION` in
`src/modules/product/product-public.mappers.ts`, consumed by
`ProductVariantRepository.findPriceSheet`. It is an **allowlist**: only the fields listed there
reach the service (typed as `PriceSheetRaw` in `ProductService`), and `ProductService.getPriceSheet`
maps them onto the response above. The following schema fields are **never** projected and must not
be added:

- `vendor_product_sku`, `prom_id` — supplier identifiers
- `prom_base_price`, `prom_discount_ratio`, `prom_discount_seen_at` — Prom pricing internals

Previously the aggregation projected `vendor_product_sku` and `prom_id` and only the service mapper
dropped them. The allowlist moves that guarantee to the query itself, so a second consumer of
`findPriceSheet` cannot leak them by accident.

**Adding a field** to the price sheet means: extend `PRICE_SHEET_PUBLIC_PROJECTION`, extend
`PriceSheetRaw` and the mapper in `getPriceSheet`, and update the projection spec
(`product-public.mappers.spec.ts`) that pins the public key set. Anything in the supplier / `prom_*`
group stays admin-only — it is available to the admin UI through `GET /products/:id/variants` and
`GET /products/:id/variants/:variantId` (see `src/docs/RBAC.md`).

## Derived fields (manufacturer / material / colour)

These are **not** stored as dedicated fields — they are derived in `ProductService.getPriceSheet`:

- **manufacturer** — first `product.attributes[]` whose label (`l`) matches `/виробник/i`,
  `/manufactur/i`, `/бренд/i` or `/brand/i`. `null` if none.
- **material** (deprecated 2026-11-06, kept for a storefront deployed ahead of the backend) — v1
  only: first `product.attributes[]` whose label (`l`) matches `/матер/i` or `/material/i`, using its
  value (`v`); `null` for a typed category, whose characteristics are in `values`.
- **color** — if the product's `variant_type.label` looks like a colour axis (`/колір|цвіт|color/i`),
  the variant's `v_value` is the colour. Otherwise only a colour-labelled attribute is used.
  A joined dictionary label takes precedence. `null` if none.

A v2 row's manufacturer is named explicitly — the brand entity, else the characteristic marked
`semantic: brand` (`legacyShapeOf(...).manufacturer`, owner 2026-11-05). For v1 rows and the other
columns, if your attribute labelling differs, adjust the regexes in
`src/modules/product/product-attribute.helpers.ts` (`MANUFACTURER_PATTERNS`, `MATERIAL_PATTERNS`,
`COLOR_PATTERNS`). They live there rather than in `ProductService` because the admin price list PDF
derives brand and colour the same way — see [PRICE_LIST_PDF.md](./PRICE_LIST_PDF.md). Changing a
pattern changes both features.

## Frontend

`fillando-fe/src/app/(root)/price-sheet/` — public page (`/price-sheet`). Each category is a section:
its name, then a table with Фото, Назва, the category's columns, Артикул, Вартість, Кількість,
Синхронізовано and the cart button. Has a dedicated full-width `layout.tsx` (no `max-w-7xl`) so the
wide tables fit; the global header/footer still wrap it. Debounced search,
compact rows, an availability dot, and a thumbnail that enlarges on row hover. Linked from the site
header (Прайс-лист). Sync date is shown as `HH:mm DD.MM.YYYY`. The rightmost column is an
add-to-cart button (`useCartStore.addItem`, guest + auth) — disabled when out of stock, shows
"В кошику" + opens the cart when the variant is already added. Product name and photo link to
`/products/{slug}` in a new tab. **Responsive:** the table renders on `md+`; on phones it switches
to a card list (`MobileCard`) under the same category headings, the column values as «label: value»
pairs, and the add-to-cart button.

**Infinite scroll:** pages are loaded incrementally with React Query `useInfiniteQuery` (offset
paging via the `page` param). The next page is fetched when an `IntersectionObserver` sentinel below
the table nears the viewport (`rootMargin: 600px`). Rendered as a semantic `<table>` (no list
virtualization) — this keeps native Ctrl/Cmd+F, table semantics, and avoids clipping the
enlarge-on-hover image. Optimizations: `keepPreviousData` + `staleTime`, debounced search,
`React.memo` rows, lazy images. Backend ordering (`_hasStock`, then `name`) is deterministic, so
offset paging stays consistent across pages. Virtualization was intentionally dropped — revisit only
if the catalog grows to tens of thousands of variants.

## General catalogue display (local Plan-0010)

The additive `variant_label` field displays any variant axis, while `color` is now
restricted to dictionary/explicit colour or a colour-axis value. A size/current is
never a colour fallback. FE uses `variant_label ?? color` for compatibility with
older responses and labels the column «Варіант». Prices, stock and SKU stay unchanged.
The response contract is documented by `PriceSheetResponseDto` in OpenAPI.

### Typed columns (local Plan-0010 B11, 2026-10-28)

`GET /products/price-sheet` already read visible categories only; a v2 product now also fills its
columns from typed values rather than the legacy rollback image: `PublicCatalogService` passes the
visible categories to `getPriceSheet`, and `legacyShapeOf` turns `attributes_v2` + the axis into the
same `manufacturer`, `material`, `color` and `variant_label` (an edit in the new editor reaches the
sheet; a v2-native product gets a manufacturer from its characteristic or brand entity). The
search also matches typed text values (`product.attributes_v2.v`). The projection gained five
internal inputs (`category_id`, `attributes_v2`, `variant_axis`, `variant_value`, `brand_name`,
null on v1 rows) — reviewed 2026-10-28: the service maps every row field by field and none of
them reaches the response (2026-11-06: `category_id` now does, on purpose — the row's section); the
literal allowlist and `catalog-legacy-exports.int-spec.ts` pin that.
Rehearsal on the 27.10 dump: all 301 rows identical before and after the migration.
