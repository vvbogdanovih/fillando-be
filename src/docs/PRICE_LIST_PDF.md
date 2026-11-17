# Wholesale Price List PDF (admin)

## Overview

A print-ready A4 PDF price list for the admin panel, in either orientation — a **stock extract**: one
table per category, with that category's own characteristic columns, quantity and the base price.
There are no wholesale discount columns (owner, 2026-11-06: «хай буде просто вижимка наявності,
знижку буду сам людині говорити»); the former «Ціна від 50кг / 100кг» tiers and their
`tier1_percent`/`tier2_percent` were removed. Rows are **grouped by product**: the product's name and
its product-level values occupy cells merged (`rowspan`) across all of its variants, mirroring the
merged-cell spreadsheet the business already used. Within a category products are ordered by
**brand**, then product name, then variant.

Distinct from [PRICE_SHEET.md](./PRICE_SHEET.md), which is the public paginated JSON table: this one
is admin-only, unpaginated, and returns a binary PDF.

## Endpoint

### `POST /products/price-list/pdf`

**Auth:** `JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)` — admin-only, like every other write
endpoint on `ProductController` (see [RBAC.md](./RBAC.md)). Guard order matters: `RolesGuard` reads
`req.user.role`, which only exists after `JwtAuthGuard` has validated the token.

**Body** (`GeneratePriceListDto`):

| Field | Type | Default | Notes |
|---|---|---|---|
| `category_ids` | `string[]` (mongo ids, max 200) | — | Omit or send `[]` for **all** categories |
| `in_stock_only` | `boolean` | `false` | `stock > 0` only. Must be a real boolean — `"true"` is rejected |
| `orientation` | `'portrait' \| 'landscape'` | `'portrait'` | A4 page orientation; landscape widens every column (the admin dialog sends `landscape` by default) |

The global `ValidationPipe` strips unknown fields (`whitelist`), so an older admin still sending
`tier1_percent`/`tier2_percent` gets the same PDF.

**Response:** `200/201` with `Content-Type: application/pdf`,
`Content-Disposition: attachment; filename="price-list-YYYY-MM-DD.pdf"`, `Content-Length`. The
filename is deliberately ASCII: `Content-Disposition` without RFC 5987 encoding mangles Cyrillic.

**Errors:**

| Code | When |
|---|---|
| `400` | No variants match the filters — `Немає товарів за обраними фільтрами` |
| `400` | More than `MAX_ROWS` (20 000) matching rows — asks the admin to narrow categories |
| `409` | Another price list is already generating (see *Single-flight* below) |

## Columns

Each category is a section: its name as a heading, then its own table (the `<thead>` repeats on
every page the table spans). Sections come in catalogue order (`productCategories()`).

| # | Header | Source |
|---|---|---|
| 1 | `SKU` | `product_variants.sku` (the internal `FL-000123` article) |
| 2 | `Назва` | `products.name` — **merged across the product's variants** |
| 3… | the category's columns | `priceColumnsOf` (`src/modules/product/price-columns.ts`, shared with the public price sheet): every definition with a filter plus the colour (`semantic: color`), in the category's order, kept while all products share one value. Values by `priceValuesOf`: label and unit («1.75 мм», «Шовковий (Silk)»), several values joined by «, ». A product-level value is **merged across the product's variants**; the column of the product's axis is one cell per SKU (a colour axis as the dictionary names it, «Чорний (Black)») |
| … | `Варіант` | only when a section needs it: a v1 category (no columns until it is migrated) or a product whose axis is not one of the columns — stored display-name suffix, otherwise variant value; `—` when absent |
| n−1 | `К-ть` | `product_variants.stock`, `0` when empty (shown as `0`, not a dash) |
| n | `Ціна` | `product_variants.price` |

Prices are whole hryvnias. The template therefore formats with `maximumFractionDigits: 2,
minimumFractionDigits: 0` rather than reusing `formatPrice` from
`src/modules/order/helpers/format.helpers.ts`, which hard-codes 2 decimals and appends `₴` per cell.
Column widths are computed per section: SKU, quantity and price fixed, the name and the
characteristic columns share the rest. Selected category names also appear once in the header's
filter summary line.

## Filtering and ordering

Always restricted to `status === 'active'`; `draft` and `archived` variants never appear.

`ProductVariantRepository.findPriceListRows` does the cheap, index-friendly work: `$match` (status,
optional `category_id: $in`, optional `stock > 0`), a `$lookup` into `products` projecting only
`name`/`attributes`/`variant_type` and the typed fields, the active brand entity and the dictionary
colour, then a deterministic `$sort` and `$limit`. The
`{ category_id: 1, status: 1 }` index covers the "some categories" case; "all categories" is a
collection scan on `status`, which is tens of milliseconds at current catalogue size. Add
`{ status: 1, stock: 1 }` if that ever becomes hot.

**The final ordering happens in JS, deliberately** (`PriceListService.buildSections` /
`buildBlocks`):

- Brand is a **regex match on a human-entered attribute label** (`Виробник`, `виробник`, `Бренд`, …).
  `$regexMatch` with `options: 'i'` gives no guaranteed Unicode case-folding for Cyrillic, so a case
  miss would silently drop the brand; and duplicating the pattern list as a Mongo alternation would
  create a second source of truth that drifts from the price sheet's.
- Mongo's default collation is **binary**: it sorts `Ю` before `а` and all Latin before all Cyrillic,
  which is visibly wrong. `Intl.Collator('uk-UA', { sensitivity: 'base', numeric: true })` is correct
  and unit-testable.
- The whole result set is loaded anyway (the PDF is unpaginated), so sorting in JS costs no extra I/O.

Products with **no** brand attribute sort last. Rows are grouped by `product_id`, never by name — two
distinct products may share a name and must not merge into one cell.

Brand/colour derivation is shared with the public price sheet via
`src/modules/product/product-attribute.helpers.ts`.

## Why blocks instead of one big rowspan

A `<td rowspan>` whose row group crosses a page break renders unreliably in Chromium — the merged
cell's text or its bottom border goes missing depending on the version. So:

1. Each product group is sliced into blocks of at most `MAX_ROWS_PER_BLOCK` (**16**) rows.
2. Each block is its own `<tbody class="grp">` with `break-inside: avoid`. Chromium honours that on
   row groups, so a block that does not fit moves whole to the next page and the `rowspan` is always
   contained within one page fragment.
3. Blocks after the first repeat the product name with a `(продовження)` marker.
4. The column header repeats via a real `<thead>` + `display: table-header-group`.

Slicing is **even, not greedy** — 17 variants become 9 + 8, not 16 + 1, because a lone trailing row
under its own repeated product name reads as a glitch.

At `font-size: 9px` a page fits ~55 rows portrait and ~37 landscape (the shorter page), so a 16-row
block always fits either way. 16 is set that high on purpose: real filament products carry 10–16
colours, and a spurious `(продовження)` split on an ordinary product is more noticeable than the gap
a large block may leave at the foot of a page.

**One block size for both orientations is deliberate.** A smaller landscape block (11) was measured
and barely moved the trailing gap — a block that moves down whole leaves ~18% of the page empty
either way — while it *did* add a `(продовження)` split to ordinary 12–16 colour products. The gap is
inherent to `break-inside: avoid`; the spurious split is not.

**Do not "simplify" this into a single `rowspan` per product.** Rejected alternatives: a true
page-spanning span (the rendering artifacts above, plus an unlabelled continuation column that reads
as a bug); measuring row heights in `page.evaluate` and pre-paginating exactly (three times the code,
double the render time, re-breaks whenever host font metrics change); dropping merged cells entirely
(contradicts the requirement).

## Rendering

`PriceListPdfProvider` is a deliberate near-copy of `InvoicePdfProvider`. It cannot reuse it:
`OrderModule` already imports `ProductModule`, so importing back would be a **circular module
dependency** — and `InvoicePdfProvider.generatePdf(html)` takes no options, while this needs
`displayHeaderFooter` for page numbering. *Follow-up:* hoist a shared `PdfProvider` into
`src/common/` once there is a `CommonModule` to hang it on.

Details that matter:

- **Fonts.** The Alpine runtime image installs only `ttf-freefont`, so `FreeSans` is the one font
  that resolves *and* covers Cyrillic. It must stay first in the stack — dropping it renders every
  Ukrainian label as tofu boxes in production while still looking fine on a developer's macOS.
- **Header/footer templates** inherit nothing from the document: every style is inline and
  `font-size` is stated explicitly (the default is ~6px). They render *inside* the margin box, hence
  the roomy `top: 18mm` / `bottom: 14mm`. Only the `pageNumber`, `totalPages`, `date`, `title` and
  `url` classes are substituted — `date` is **not** used, because Chromium renders it in its own
  locale (`M/D/YY`), clashing with the uk-UA timestamp in the body.
- **HTML escaping is mandatory.** Product names and colours are vendor-scraped and do contain `&`,
  `<` and quotes. The invoice template gets away without escaping because its data is admin-entered.
- `printBackground: true` is required for the grey `thead`.
- **`body { padding: 0 1px }` is load-bearing, not cosmetic.** With `border-collapse: collapse` the
  outer border is centred *on* the table's edge, so half of it sits outside the border box. A table
  at exactly 100% of the printable width therefore has its rightmost border land on the clip
  boundary, and Chromium drops it — the last column prints with no right edge while the left one
  looks fine. The 1px inset keeps it inside. Removing it silently reintroduces the bug.
- **Orientation** is passed as puppeteer's `landscape` flag on `page.pdf`, not via an `@page` CSS
  rule, so there is no `preferCSSPageSize` juggling. Column widths are percentages computed per
  section from what the columns hold (`columnWidths`: room for the longest text up to a cap, never
  less than the longest word plus padding), so landscape's 267mm of printable width versus 190mm
  portrait widens every column. The filament's nine characteristic columns fit landscape; portrait
  breaks their headers mid-word, so the admin dialog defaults to landscape (2026-11-06).
- `PUPPETEER_EXECUTABLE_PATH` from the Dockerfile is picked up automatically — never hardcode
  `executablePath`.
- `protocolTimeout: 180_000` on launch plus explicit `setContent`/`pdf` timeouts, otherwise a large
  document trips puppeteer's default protocol timeout with an opaque error mid-render.

**Logo.** `Fillando-logo.png` lives only in the frontend's `public/`; the backend image ships no
assets and `nest-cli.json` copies none. It is fetched once from `${FRONTEND_URL}/Fillando-logo.png`,
downscaled with `sharp` (285 KB / 2199×518 → ~11 KB / 221×52, which otherwise dominated the PDF
size) and cached in-process as a data URI. It is **not** left as a remote `<img>`, because
`waitUntil: 'load'` would hang if the frontend were unreachable. Failure is non-fatal — the template
falls back to a `FILLANDO` text wordmark and logs a warning.

## Limits

- **`MAX_ROWS = 20_000`.** Beyond that the container OOMs instead of returning an error, so the cap
  *is* the protection (~20k rows ≈ 400 pages ≈ 30 s ≈ 1.5 GB peak). If the catalogue ever exceeds
  ~20k active variants, the answer is XLSX or a queued job writing to S3 — not a bigger cap.
- **Single-flight.** Every call forks a Chromium; two admins double-clicking is enough to OOM the
  container. A private flag rejects concurrent runs with `409`, reset in `finally`. Per-instance only,
  which matches the deployment (`RUN_CRON` implies effectively one instance).
- No streaming — `res.end(buffer)` matches the invoice/report pattern and the frontend's blob download.
- Measured on the dev catalogue: 300 rows → 6 pages, ~770 KB, a couple of seconds.

## Files

| Path | Role |
|---|---|
| `src/modules/product/price-list/price-list.service.ts` | query → group → chunk → template → pdf |
| `src/modules/product/price-list/price-list.template.ts` | HTML/CSS, escaping, formatting |
| `src/modules/product/price-list/price-list-pdf.provider.ts` | puppeteer wrapper |
| `src/modules/product/price-list/price-list.types.ts` | row/block/data shapes |
| `src/modules/product/product-attribute.helpers.ts` | brand/material/colour derivation, shared with the price sheet |
| `src/modules/product/dto/generate-price-list.dto.ts` | request body |
| `src/database/mongoose/repositories/product-variant.repository.ts` | `findPriceListRows` |

## Frontend

`fillando-fe/src/app/admin/products/PriceListModal.tsx` — a dialog in the `/admin/products` header
with a category checkbox list ("Всі категорії" master row), an in-stock toggle and the two percent
inputs. Downloads via bare `axios` + `responseType: 'blob'`, because the shared `httpService` would
Zod-parse the body.

## General catalogue variants (local Plan-0010)

The rendered row uses `variant_label` and the heading «Варіант». A stored name
starting with the exact product name plus ` — ` supplies its display suffix (including
Ukrainian dictionary colour). Otherwise `pickVariantLabel` keeps a size/current value
independent of colour. Sorting is by this display value, then SKU. Wholesale tier
calculation, product grouping and block splitting are unchanged. Service/template
unit coverage captures HTML; it is not a Chromium layout test.

### Local Plan-0010 read barrier

The controller returns a StreamableFile instead of writing directly to Express.
The legacy catalog interceptor verifies catalog revision/epoch after PDF generation
and before any PDF bytes/download headers are sent. Maintenance or a changed stamp
returns JSON 503 with Retry-After: 5 and Cache-Control: no-store. This preserves
normal PDF download headers/status for a stable legacy catalog. The PDF renderer
itself is unchanged; this HTTP barrier is not protection for direct service calls.

### Adapted read (local Plan-0010 B11, 2026-10-28)

The PDF handler is an adapted read (`@CatalogAdaptedRead`): it runs while the tree holds v2/draft
categories and still refuses during maintenance or a revision/epoch change. `PriceListService` reads
the public category projection: only SKUs of visible product categories are listed; a requested
hidden or unknown category contributes nothing (only hidden ones → the usual 400 «Немає товарів»),
and the header names visible categories only. A v2 row is put into the legacy shape by
`legacyShapeOf` before grouping, so the brand is named explicitly — a linked active brand entity, else
the characteristic marked `semantic: brand` (`row.brand`, never a label match; owner 2026-11-05) —
and the variant column is the stored name suffix («Чорний (Black)», «63 А»).
Rehearsal on the 27.10 dump: the PDF text before and after the migration is identical (301 rows).

After bootstrap `/admin/products` is the new catalogue workspace; its header now carries the same
«Прайс-лист» dialog (`PriceListButton`, categories from `GET /categories`), so the PDF stays
reachable once the legacy products page is fenced.
