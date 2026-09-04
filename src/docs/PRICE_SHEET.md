# Price Sheet (flat variant list)

## Overview

A paginated, flat list of **all active product variants** for the public "price sheet" page, so
anyone can quickly review the whole catalog (name, material, colour, article, price, availability,
last availability sync). Distinct from `GET /products` (grouped, admin-only) and `catalog`/`search`
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

**Sorting:** availability first — **in-stock variants before out-of-stock** (`_hasStock`). Within
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
			"manufacturer": "SUNLU | null",
			"material": "PLA | null",
			"color": "Червоний | null",
			"article": "FL-000123 | null", // internal system sku
			"price": 1235,
			"in_stock": true,
			"stock": 48, // available quantity
			"synced_at": "ISO | null" // stock_updated_at
		}
	],
	"total": 1234,
	"page": 1,
	"limit": 50
}
```

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
- **material** — first `product.attributes[]` whose label (`l`) matches `/матер/i` or `/material/i`,
  using its value (`v`). `null` if none.
- **color** — if the product's `variant_type.label` looks like a colour axis (`/колір|цвіт|color/i`),
  the variant's `v_value` is the colour. Otherwise a colour-labelled attribute, falling back to
  `v_value`. `null` if none.

If your attribute labelling differs, adjust the regexes in
`src/modules/product/product-attribute.helpers.ts` (`MANUFACTURER_PATTERNS`, `MATERIAL_PATTERNS`,
`COLOR_PATTERNS`). They live there rather than in `ProductService` because the admin price list PDF
derives brand and colour the same way — see [PRICE_LIST_PDF.md](./PRICE_LIST_PDF.md). Changing a
pattern changes both features.

## Frontend

`fillando-fe/src/app/(root)/price-sheet/` — public page (`/price-sheet`). Has a dedicated
full-width `layout.tsx` (no `max-w-7xl`) so the wide 9-column table fits; the global header/footer
still wrap it. Debounced search,
compact rows, an availability dot, and a thumbnail that enlarges on row hover. Linked from the site
header (Прайс-лист). Sync date is shown as `HH:mm DD.MM.YYYY`. The rightmost column is an
add-to-cart button (`useCartStore.addItem`, guest + auth) — disabled when out of stock, shows
"В кошику" + opens the cart when the variant is already added. Product name and photo link to
`/products/{slug}` in a new tab. **Responsive:** the table renders on `md+`; on phones it switches
to a card list (`MobileCard`) with the same data and the add-to-cart button.

**Infinite scroll:** pages are loaded incrementally with React Query `useInfiniteQuery` (offset
paging via the `page` param). The next page is fetched when an `IntersectionObserver` sentinel below
the table nears the viewport (`rootMargin: 600px`). Rendered as a semantic `<table>` (no list
virtualization) — this keeps native Ctrl/Cmd+F, table semantics, and avoids clipping the
enlarge-on-hover image. Optimizations: `keepPreviousData` + `staleTime`, debounced search,
`React.memo` rows, lazy images. Backend ordering (`_hasStock`, then `name`) is deterministic, so
offset paging stays consistent across pages. Virtualization was intentionally dropped — revisit only
if the catalog grows to tens of thousands of variants.
