# Google Shopping feed

The backend publishes a Google Merchant Center product feed (TD-0006 §5.3) — a static RSS 2.0
document with `g:` attributes, rebuilt from the catalogue on startup and every hour, served from
memory. Bing Merchant Center and Meta Commerce Manager read the same format.

Module: `src/modules/feed/`. Working set: `ProductVariantRepository.findActiveForFeed()`.

## Endpoints

| Method | Path                               | Access | What                                                                   |
| ------ | ---------------------------------- | ------ | ---------------------------------------------------------------------- |
| `GET`  | `/feeds/google-shopping.xml`       | public | the feed — register this URL in Merchant Center                        |
| `POST` | `/feeds/google-shopping/regenerate` | ADMIN  | rebuild now, synchronous; returns the generation summary; 409 if running |
| `GET`  | `/feeds/google-shopping/status`    | ADMIN  | last summary without rebuilding, plus readiness, schedule, last error   |

Paths in `ENDPOINTS.FEEDS`, Swagger text in `API_OPERATION.FEEDS`.

## Cold start — why the GET can answer 503

The XML is kept in memory only (one `api` instance; a replica would need the cache moved into a
Mongo document, a change confined to `FeedService`). After a restart there is nothing to serve
until the first generation finishes, and on Railway restarts are routine. So:

1. `FeedCronService.onModuleInit` starts a generation **unconditionally** — not gated on
   `RUN_CRON` — so the feed is ready seconds after boot.
2. Until then `GET /feeds/google-shopping.xml` answers **503 + `Retry-After: 60`** with a JSON
   body. Merchant treats that as a failed fetch and retries on its schedule; items are kept for
   30 days after the last successful fetch. An **empty `<channel>`** would instead be read as
   "every item is gone" and delist the catalogue — that is why the endpoint never serves one.
3. A failed regeneration keeps the previous XML and records `last_error` for the status screen.

The hourly job honours `RUN_CRON` like the Prom sync, with the same overlap guard
(`FeedService.isRunning`); `POST /regenerate` is the manual fallback and answers 409 while a
generation is running.

## Item mapping

| Feed field                           | Source                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `g:id`                               | `variant.sku`                                                                                                            |
| `g:item_group_id`                    | `variant.product_id` — groups the colours of one product                                                                 |
| `title`                              | `variant.name`, capped at 150 chars                                                                                      |
| `description`                        | `product.description.html` → `sanitizePlainText`, whitespace collapsed, capped at 5000; the title when empty (+ warning) |
| `link`                               | `${FRONTEND_URL}/products/${slug}` — the page's canonical                                                                |
| `g:image_link` / `g:additional_image_link` | `images[0]` / `images[1..10]`, **original URLs** — the same ones Product JSON-LD uses, so feed and page agree        |
| `g:availability`                     | `in_stock` when `stock > 0`, else `out_of_stock` — underscored, as in Google's attribute reference                        |
| `g:price`                            | `"{price.toFixed(2)} UAH"`; no `sale_price` — `price` is already final                                                   |
| `g:brand`                            | the «Виробник» attribute via `pickAttr(MANUFACTURER_PATTERNS)`. **Never `Vendor.name`** — the vendor is the supplier    |
| `g:google_product_category`          | `category.google_product_category.id`; omitted (+ warning) when null                                                     |
| `g:product_type`                     | `"{Category.name} > {Landing.h1}"` for the most specific active landing whose pinned filters the product matches, else the category name |
| `g:condition` / `g:identifier_exists` | constants `new` / `false` — no GTIN/MPN in this catalogue                                                                |
| `g:color`                            | dictionary `color.name_uk`; `pickColor()` heuristic only where the dictionary has a gap                                  |
| `g:material`                         | the `polymer` attribute; `pickAttr(MATERIAL_PATTERNS)` until the taxonomy migration has run                              |
| `g:shipping_weight`                  | `"{weight_g / 1000} kg"`; omitted (+ warning) when null                                                                  |
| `g:custom_label_0..3`                | category name · manufacturer · stock depth (`deep` >10 / `low` 1–10 / `out` 0) · price band (`budget` <500 / `mid` ≤1500 / `premium`) |

**There is no margin label and no supplier value anywhere in the feed.** The first design had a
margin bucket in `custom_label_2`; it was dropped (owner, 2026-09-06) because the shop resells at
supplier price + margin, and the same `API_AND_SWAGGER.md` rule that hides `prom_*` from public
endpoints applies to the feed. Stock depth segments campaigns just as well and is already public.

### Exclusions (hard Merchant requirements)

| Reason              | When                                        |
| ------------------- | ------------------------------------------- |
| `missing_brand`     | no «Виробник» attribute — no shop-name fallback |
| `no_images`         | no image URL                                |
| `no_price`          | price missing or ≤ 0                        |
| `dangling_product`  | the variant's product is gone               |
| `dangling_category` | the variant's category is gone              |

DRAFT and ARCHIVED variants never reach the builder — `findActiveForFeed` matches `ACTIVE` only.
`stock = 0` is **not** an exclusion: the item stays with `out_of_stock`, so its history in
Merchant survives a stock-out.

### Warnings (item stays, Google lists it worse)

`no_google_product_category`, `no_description`, `no_weight`, `missing_required_attribute` (with a
count per missing key). This is where the category's `required_attributes` get visibility without
enforcement on write (TD-0006 §2).

## Where the numbers come from

- **Weight** — `ProductVariant.weight_g`, backfilled by `scripts/fillando_v_2/backfill-variant-weight.js`:
  the «Вага» attribute (kilograms) plus a **220 g spool** unless the variant is a refill. The spool
  figure is an assumption in the 200–250 g range; the report flags heavier reels and the admin can
  correct any variant in the product form.
- **Shipping rates** — `yarn shipping:rates` (`scripts/shipping-rates.js`) asks Nova Poshta's
  `InternetDocument.getDocumentPrice` for Львів → Львів and Львів → Київ at 2 kg and 10 kg and
  writes `scripts/shipping-rates.json`. The storefront's `SHIPPING_RATE_TABLE` and Merchant
  Center's account-level shipping are both filled from that file — one source, three surfaces.
  Rerun it when the contract changes; never edit the numbers by hand.

## Operating it in Google

Feed URL, fetch schedule (≥ hourly), shipping and return policy live in Merchant Center; Search
Console verification and the GA4 property are frontend build args (TD-0006 §5.5–§5.6, Plan-0006
tasks 30–34). Two things to get right in the cabinets, not in code:

1. **Register the feed only after the release and the catalogue migrations** — otherwise the
   first fetch sees the catalogue before colour standardisation and without landings in
   `product_type`.
2. **Do not import the GA4 `purchase` event into Google Ads as a conversion.** The Ads pixel is
   the one conversion source for bidding; GA4 supplies auxiliary signals. Importing both counts
   every order twice.

## Testing

Unit: `google-shopping-feed.builder.spec.ts` (every field, every exclusion, every warning, no
supplier value), `product-type.resolver.spec.ts`, `feed.service.spec.ts` (cold start, summary,
overlap guard, failure keeps the last XML). RBAC: `feed.controller.rbac.spec.ts` (public XML,
503 before the first generation, admin-only regenerate/status). Integration:
`product-variant.repository.int-spec.ts` — `findActiveForFeed` returns ACTIVE only and no supplier
field.
