# Prom Availability & Price Sync

## Overview

Admin-triggered synchronization of product **stock and price** from the Prom marketplace
([public API](https://public-api.docs.prom.ua/)). For every `ProductVariant` that has a `prom_id`,
the backend fetches the product from Prom, writes the current quantity into `stock`, and
recalculates `price` from the vendor price plus a tiered markup — in stock and out of it alike.

This replaces the older HTML-scraping approach (`scripts/AvailabilityCheck/...`) with the official
API; the price algorithm is ported verbatim from
`scripts/AvailabilityCheck/prod/UpdatePriceNicePrice.js`. The scraper scripts remain available but
are independent of this flow.

---

## Data

- Source field: `ProductVariant.prom_id` — the Prom product id (the digits in a product URL such as
  `https://npshop.com.ua/ua/p3012625429-...` → `3012625429`). Editable from the admin product form.
- Target fields: `ProductVariant.stock`, `stock_updated_at`, `price`, `price_updated_at`,
  `prom_base_price`, `prom_discount_ratio`, `prom_discount_seen_at`.
- `prom_discount_ratio` is the last discount Prom reported for the variant, held as a **fraction of
  the pre-discount price** rather than an absolute ₴ amount: the vendor's base price moves, so a
  stale ₴ figure would misprice while a stale ratio would not. `prom_base_price` is the last
  pre-discount price seen, kept purely so a stored `price` can be traced back to its inputs.

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
shows `740 ₴`, so `740` is the vendor price and `740 + 45 = 785 ₴` is ours. Losing the discount
inflates the shop price by a median **+28.7%** across the vendor's catalogue (max +35%).

### Which discount gets applied

Prom stops reporting a discount for two very different reasons, and the sync has to tell them
apart:

| Prom payload | Discount used | Why |
| ------------ | ------------- | --- |
| `discount` present, window open | the payload's, and `prom_discount_ratio` is refreshed from it | normal case |
| `discount` present, window closed | none — the bare `price` | the promo genuinely ended; that is a real price rise |
| `discount` absent, variant **out of stock** | `prom_discount_ratio`, replayed against the current base | Prom **withholds** the object for out-of-stock listings; the bare `price` it reports is pre-discount |
| `discount` absent, variant **in stock** | none — the bare `price`, subject to the jump guard below | in stock, a missing object means there is no promo |
| `discount` absent, no ratio ever recorded | — | nothing trustworthy to price from; the stored price stands |

A remembered ratio expires after `SNAPSHOT_TTL_DAYS` (60), so a promo the vendor cancelled for good
cannot keep an out-of-stock variant artificially cheap forever. Only a discount Prom actually
reported refreshes `prom_discount_seen_at` — replaying the remembered one deliberately leaves the
timestamp alone, otherwise the TTL would renew itself on every sync and never expire. Once it does
expire, the variant falls into the last row of the table and holds its price.

**Out-of-stock variants are repriced too.** The sync used to skip the price write entirely while
`stock <= 0`. That stopped a bad price from being *written* at the moment an item went out of stock,
but it also **froze** whatever price was already stored — a price inflated during a promo gap, or by
the legacy scrapers (which scraped the rendered page price with no availability check at all), stayed
visible for as long as the item remained unavailable. Replaying the last known discount keeps those
prices real and lets them self-heal.

### Jump guard

The vendor runs a rolling promo campaign that it periodically re-creates. In the gap between
campaigns Prom reports the bare pre-discount price for the whole catalogue, which would inflate every
in-stock variant by roughly a third. So when the payload carried **no discount at all** and the
computed price is more than `MAX_UNDISCOUNTED_JUMP` (15%) above the stored one, the price write is
skipped, a `warn` is logged with the SKU and both prices, and the run's `priceSkipped` counter goes
up. When Prom *does* send an active discount the computed price is trusted however far it moves —
that is a genuine vendor price change.

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
| `progress` | `{ total, processed, updated, pricesUpdated, priceSkipped, skipped, errors }`         |
| `done`     | `{ total, processed, updated, pricesUpdated, priceSkipped, skipped, errors }` (final) |
| `error`    | `{ message }`                                                                        |

- `updated` — variant was written (stock always, price when applicable).
- `pricesUpdated` — subset of `updated` whose `price` actually changed.
- `priceSkipped` — price writes rejected by the jump guard. A non-zero value on a large share of the
  catalogue means the vendor's promo campaign has lapsed.
- `skipped` — variant's Prom product returned 404 / not found.
- `errors` — fetch failed after retries; the variant is left unchanged.

---

## Implementation

Module: `src/modules/prom/`

- `prom.service.ts` — `getProduct(promId)`: `axios` GET with Bearer auth; retries on `429` / `5xx` /
  network errors (linear backoff, 3 attempts); returns `null` on `404`.
- `prom-pricing.ts` — pure pricing helpers: `resolveVendorPrice(product, snapshot, outOfStock, now)`
  (picks the discount per the table above, applies currency/validity guards, and reports which
  source it used) and `resolveShopPrice(vendorPrice)` (tiered markup + rounding). The markup tiers
  live here as `MARKUP_TIERS` / `TOP_TIER_MARKUP` — edit them to change the algorithm. Covered by
  `prom-pricing.spec.ts`.
- `prom-sync.service.ts` — `syncAvailability(onProgress?)`: core routine; loads variants via
  `ProductVariantRepository.findAllWithPromId()`, processes them **sequentially** with a ~400ms
  delay between requests, builds the stock+price patch in `buildPatch`, applies the jump guard in
  `isUndiscountedJump`, updates the DB. Guards against overlapping runs via `isRunning`. Covered by
  `prom-sync.service.spec.ts`. `syncWithProgress(): Observable<MessageEvent>` is the
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

## Backfill

`scripts/migrations/backfill-prom-discount-ratio.js` seeds `prom_discount_ratio` for the existing
catalogue and corrects the prices frozen by the old behaviour. Variants Prom currently reports
without a discount fall back to `VENDOR_DEFAULT_RATIO = 3/13`.

That figure is the vendor's own pricing rule rather than an estimate: it builds the listed
pre-discount price by marking the real price up 30%, then discounts back down to it. The real price
is therefore `base / 1.3` — a discount of `3/13`, or 23.0769…%, of the base. It must be computed as
`base / 1.3` and **not** as a literal −23%: the two disagree on 670 of the 1212 live ×1.3 discounts
in the vendor's catalogue, by 1–2 ₴ each, and only `/ 1.3` reproduces the price Prom reports.

Runs with `DRY_RUN = true` by default; the report flags any variant whose price would go **up**,
which is worth reading before writing.

---

## Notes / future work

- Currently per-variant `GET /products/{id}`. For very large catalogs, a bulk `GET /products/list`
  pass (build an id→presence/quantity map) would use fewer requests.
- The 30-minute interval is set via `CronExpression.EVERY_30_MINUTES` in `prom-cron.service.ts`.
