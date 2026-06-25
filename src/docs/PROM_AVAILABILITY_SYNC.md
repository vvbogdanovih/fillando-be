# Prom Availability Sync

## Overview

Admin-triggered synchronization of product **stock** from the Prom marketplace
([public API](https://public-api.docs.prom.ua/)). For every `ProductVariant` that has a `prom_id`,
the backend fetches the product from Prom and writes the current quantity into `stock`.

This replaces the older HTML-scraping approach (`scripts/AvailabilityCheck/...`) with the official
API. The scraper scripts remain available but are independent of this flow.

---

## Data

- Source field: `ProductVariant.prom_id` — the Prom product id (the digits in a product URL such as
  `https://npshop.com.ua/ua/p3012625429-...` → `3012625429`). Editable from the admin product form.
- Target fields: `ProductVariant.stock` and `ProductVariant.stock_updated_at`.

---

## Prom API

- Base URL: `https://my.prom.ua/api/v1`
- Auth header: `Authorization: Bearer <PROM_API_KEY>` (env var, validated in `env.constant.ts`).
- Endpoint used: `GET /products/{id}` → `{ product }`.
- Relevant response fields: `quantity_in_stock` (number), `in_stock` (bool), `presence`
  (`available | not_available | order | service | waiting`), `status`.

### Stock mapping

```
if (in_stock === false || presence === 'not_available') stock = 0
else if (typeof quantity_in_stock === 'number')         stock = quantity_in_stock
else                                                     stock = 1   // in stock, no exact number
```

`stock_updated_at` is set to the current time on every successful update.

---

## API Endpoint

### `GET /api/prom/sync-availability` (SSE)

**Auth:** JWT required, `ADMIN` role only (`JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`).

Server-Sent Events stream. The client opens it with `EventSource(url, { withCredentials: true })`
so the `access_token` cookie authenticates the stream.

**Events** (`data` is JSON):

| `type`     | Payload                                                  |
| ---------- | -------------------------------------------------------- |
| `progress` | `{ total, processed, updated, skipped, errors }`         |
| `done`     | `{ total, processed, updated, skipped, errors }` (final) |
| `error`    | `{ message }`                                            |

- `skipped` — variant's Prom product returned 404 / not found.
- `errors` — fetch failed after retries; the variant is left unchanged.

---

## Implementation

Module: `src/modules/prom/`

- `prom.service.ts` — `getProduct(promId)`: `axios` GET with Bearer auth; retries on `429` / `5xx` /
  network errors (linear backoff, 3 attempts); returns `null` on `404`.
- `prom-sync.service.ts` — `syncAvailability(onProgress?)`: core routine; loads variants via
  `ProductVariantRepository.findAllWithPromId()`, processes them **sequentially** with a ~400ms
  delay between requests, maps stock, updates the DB. Guards against overlapping runs via
  `isRunning`. `syncWithProgress(): Observable<MessageEvent>` is the SSE wrapper around it.
- `prom-cron.service.ts` — `@Cron(CronExpression.EVERY_30_MINUTES)` calls `syncAvailability()`;
  skips if a sync (manual or scheduled) is already running.
- `prom.controller.ts` — `@Sse(ENDPOINTS.PROM.SYNC_AVAILABILITY)` admin route.
- `prom.module.ts` — imports `ProductModule` (for `ProductVariantRepository`). `ScheduleModule.forRoot()`
  is registered in `app.module.ts`.

Frontend: `fillando-fe/src/app/admin/prom/PromSyncSection.tsx` renders the "Синхронізувати наявність"
button on the admin dashboard and consumes the SSE stream.

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
