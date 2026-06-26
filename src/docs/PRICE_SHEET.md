# Price Sheet (flat variant list)

## Overview

A paginated, flat list of **all product variants** for the public "price sheet" page, so anyone can
quickly review the whole catalog (name, material, colour, article, price, availability, last
availability sync). Distinct from `GET /products` (grouped) and `catalog`/`search` (storefront
projections that omit these fields).

## Endpoint

### `GET /api/products/price-sheet`

**Auth:** public (no guard).

**Query** (`GetPriceSheetQueryDto`): `q?` (search), `page?=1`, `limit?=50` (max 200).

**Sorting:** availability first — **in-stock variants before out-of-stock** (`_hasStock`). Within
each availability bucket, variants are **grouped by parent product** (by product name, then product
id) so a product's variants stay together and don't scatter when they were added at different times,
then by variant name. Fixed server-side. (A product with mixed availability therefore has its
in-stock variants in the top bucket and its out-of-stock ones in the bottom bucket — by design,
since in-stock items must come first.)

**Search (`q`):** case-insensitive regex over `product.name`, `vendor_product_sku`, `sku`, and
`product.attributes.v` (mirrors the storefront search fields; substring rather than `$text`).

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

## Derived fields (manufacturer / material / colour)

These are **not** stored as dedicated fields — they are derived in `ProductService.getPriceSheet`:

- **manufacturer** — first `product.attributes[]` whose label (`l`) matches `/виробник/i`,
  `/manufactur/i`, `/бренд/i` or `/brand/i`. `null` if none.
- **material** — first `product.attributes[]` whose label (`l`) matches `/матер/i` or `/material/i`,
  using its value (`v`). `null` if none.
- **color** — if the product's `variant_type.label` looks like a colour axis (`/колір|цвіт|color/i`),
  the variant's `v_value` is the colour. Otherwise a colour-labelled attribute, falling back to
  `v_value`. `null` if none.

If your attribute labelling differs, adjust the regexes in `ProductService.pickAttr` / `pickColor`.

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
