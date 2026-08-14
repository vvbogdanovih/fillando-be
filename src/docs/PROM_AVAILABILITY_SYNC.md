# Prom Availability & Price Sync

## Overview

Admin-triggered synchronization of product **stock and price** from the Prom marketplace
([public API](https://public-api.docs.prom.ua/)). For every `ProductVariant` that has a `prom_id`,
the backend fetches the product from Prom, writes the current quantity into `stock`, and — for
variants that are in stock — recalculates `price` from the vendor price plus a tiered markup.

This replaces the older HTML-scraping approach (`scripts/AvailabilityCheck/...`) with the official
API; the price algorithm is ported verbatim from
`scripts/AvailabilityCheck/prod/UpdatePriceNicePrice.js`. The scraper scripts remain available but
are independent of this flow.

---

## Data

- Source field: `ProductVariant.prom_id` — the Prom product id (the digits in a product URL such as
  `https://npshop.com.ua/ua/p3012625429-...` → `3012625429`). Editable from the admin product form.
- Target fields: `ProductVariant.stock`, `stock_updated_at`, `price`, `price_updated_at`.

---

## Prom API

- Base URL: `https://my.prom.ua/api/v1`
- Auth header: `Authorization: Bearer <PROM_API_KEY>` (env var, validated in `env.constant.ts`).
- Endpoint used: `GET /products/{id}` → `{ product }`.
- Relevant response fields: `quantity_in_stock` (number), `in_stock` (bool), `presence`
  (`available | not_available | order | service | waiting`), `status`, `price` (number),
  `currency`, `discount` (`{ type, value, date_start, date_end }` or `null`).

### Stock mapping

```
available = presence !== undefined ? presence !== 'not_available' : in_stock !== false

if (!available)                       stock = 0
else if (quantity_in_stock > 0)       stock = quantity_in_stock
else                                  stock = 1   // in stock, no exact number tracked
```

**`presence` is authoritative; `in_stock` is not a veto.** Prom returns `in_stock: false` for a
sizeable slice of listings that are `presence: 'available'` with a positive `quantity_in_stock`
(~130 of the catalog at the time of writing, including the Tri-Silk / Silk PLA lines). The earlier
mapping let `in_stock === false` win, which zeroed those variants on every sync even though Prom
showed them as in stock. `in_stock` is now only consulted when `presence` is absent from the
payload.

Likewise `quantity_in_stock: 0` on an available product means Prom tracks no exact number, not that
the item ran out — it maps to `1`, same as a missing quantity.

`stock_updated_at` is set to the current time on every successful update.

### Price mapping

Implemented in `prom-pricing.ts`, applied only when the resolved `stock > 0`.

```
vendorPrice = price − discount        (discount subtracted when present and within its date window)
shopPrice   = round(vendorPrice + markup(vendorPrice))
```

Fixed tiered markup, in ₴, by vendor price range:

| Vendor price | Markup |
| ------------ | ------ |
| ≤ 200        | +30    |
| ≤ 400        | +35    |
| ≤ 600        | +40    |
| ≤ 800        | +45    |
| ≤ 1000       | +50    |
| ≤ 1500       | +100   |
| ≤ 2500       | +110   |
| > 2500       | +120   |

**The discount must be subtracted.** Prom's `price` is the *pre-discount* amount; the reduction
lives in a separate `discount` object (`type: 'amount'` — absolute ₴ — or `'percent'`), and the
storefront shows `price − discount`. Example: `price: 962`, `discount.value: 222` → the npshop page
shows `740 ₴`, so `740` is the vendor price and `740 + 45 = 785 ₴` is ours.

**Price is only read while the product is in stock.** Prom drops the `discount` object entirely
once an item goes out of stock and reports the bare pre-discount `price` — pricing off that would
silently inflate the variant by the discount amount. Out-of-stock variants therefore keep their
last known price, and `price_updated_at` is not touched.

Other guards: a non-UAH `currency` is skipped (the tiers are denominated in ₴), as is a missing,
non-positive, or fully-discounted-to-zero price. In every skip case the existing price stands.

`price_updated_at` is set whenever a price was successfully resolved, even if the computed value
matched the stored one; `price` itself is only written when it actually changes.

---

## API Endpoint

### `GET /api/prom/sync-availability` (SSE)

**Auth:** JWT required, `ADMIN` role only (`JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`).

Server-Sent Events stream. The client opens it with `EventSource(url, { withCredentials: true })`
so the `access_token` cookie authenticates the stream.

**Events** (`data` is JSON):

| `type`     | Payload                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `progress` | `{ total, processed, updated, pricesUpdated, skipped, errors }`          |
| `done`     | `{ total, processed, updated, pricesUpdated, skipped, errors }` (final)  |
| `error`    | `{ message }`                                                            |

- `updated` — variant was written (stock always, price when applicable).
- `pricesUpdated` — subset of `updated` whose `price` actually changed.
- `skipped` — variant's Prom product returned 404 / not found.
- `errors` — fetch failed after retries; the variant is left unchanged.

---

## Implementation

Module: `src/modules/prom/`

- `prom.service.ts` — `getProduct(promId)`: `axios` GET with Bearer auth; retries on `429` / `5xx` /
  network errors (linear backoff, 3 attempts); returns `null` on `404`.
- `prom-pricing.ts` — pure pricing helpers: `resolveVendorPrice(product, now)` (discount handling,
  currency/validity guards) and `resolveShopPrice(vendorPrice)` (tiered markup + rounding). The
  markup tiers live here as `MARKUP_TIERS` / `TOP_TIER_MARKUP` — edit them to change the algorithm.
- `prom-sync.service.ts` — `syncAvailability(onProgress?)`: core routine; loads variants via
  `ProductVariantRepository.findAllWithPromId()`, processes them **sequentially** with a ~400ms
  delay between requests, builds the stock+price patch in `buildPatch`, updates the DB. Guards
  against overlapping runs via `isRunning`. `syncWithProgress(): Observable<MessageEvent>` is the
  SSE wrapper around it.
- `prom-cron.service.ts` — `@Cron(CronExpression.EVERY_30_MINUTES)` calls `syncAvailability()`;
  skips if a sync (manual or scheduled) is already running.
- `prom.controller.ts` — `@Sse(ENDPOINTS.PROM.SYNC_AVAILABILITY)` admin route.
- `prom.module.ts` — imports `ProductModule` (for `ProductVariantRepository`). `ScheduleModule.forRoot()`
  is registered in `app.module.ts`.

Frontend: `fillando-fe/src/app/admin/prom/PromSyncSection.tsx` renders the "Синхронізувати наявність
і ціни" button on the admin dashboard and consumes the SSE stream.

The route is still named `sync-availability` for backwards compatibility, even though it now syncs
price as well.

---

## Scheduling

A scheduled job (`@nestjs/schedule`) runs the sync **every 30 minutes** automatically
(`PromCronService`). Manual runs via the dashboard button and the scheduled job share the same
`PromSyncService` and the same overlap guard, so they never run concurrently — whichever starts
second is skipped (cron) or reports "вже виконується" (manual SSE).

**`RUN_CRON` flag.** The scheduler is only registered when env `RUN_CRON` is truthy (`true` / `1`);
otherwise `PromCronService.onModuleInit` logs and registers nothing (no timer ticks at all). The
overlap guard is per-process only, so with multiple replicas set `RUN_CRON=true` on **exactly one**
instance — others leave it unset/false. The manual dashboard button works regardless of `RUN_CRON`.

---

## Notes / future work

- Currently per-variant `GET /products/{id}`. For very large catalogs, a bulk `GET /products/list`
  pass (build an id→presence/quantity map) would use fewer requests.
- The 30-minute interval is set via `CronExpression.EVERY_30_MINUTES` in `prom-cron.service.ts`.
