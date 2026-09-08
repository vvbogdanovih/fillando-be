# Storefront cache revalidation

The storefront (`fillando-fe`) caches its backend reads for an hour (`serverFetch`,
`revalidate: 3600`) and prerenders the sitemap. Without a purge, anything saved in the admin
reaches shoppers up to an hour later (or after a restart). The frontend exposes
`POST /api/revalidate` for that; in production **the backend is the caller** — this document is
the backend half of the contract described in fillando-fe `docs/cache-revalidation.md`.

Until Plan-0005 I-h only landing writes purged anything, so the server-rendered product page,
its `Product` JSON-LD and its metadata lagged behind the admin. The worst case is a page that
still says «в наявності» while the Merchant feed — built per request, uncached — already says
the opposite, and an archived product that keeps its indexable page for the rest of the hour.

## The resources

`resource` is a closed enum on both sides. The caller never names a tag, a path or a slug, so
nothing in a request body can widen the blast radius; a name missing from the frontend's
`INVALIDATIONS` purges nothing and answers 400, which means **a new resource has to be added to
both lists in the same release**.

| Resource     | Purges on the storefront                                              |
| ------------ | --------------------------------------------------------------------- |
| `landings`   | the landing pages, the «Популярні види» tiles, the sitemap            |
| `products`   | the product page, its JSON-LD and metadata, the catalogue listing     |
| `categories` | the category pages — names, breadcrumbs, filter dimensions and units  |

## Who calls it

The sender is shared: `src/common/services/storefront-revalidation.service.ts`.

| Write                                                                          | Resource     |
| ------------------------------------------------------------------------------ | ------------ |
| `ProductService.create` / `update` / `delete`                                  | `products`   |
| `ProductService.addVariant` / `updateVariant` / `deleteVariant`                 | `products`   |
| `ProductService.setVariantImages`                                              | `products`   |
| `CategoryService.create` / `update` / `replace` / `delete`                      | `categories` |
| `ColorService.update`                                                          | `products`   |
| `LandingService.create` / `update` / `delete`                                   | `landings`   |

Notes on the less obvious rows:

- **`updateVariant` is the busy one.** Price, stock, weight and status all arrive through that
  single endpoint, and every one of them is on the page, in the JSON-LD and in the feed.
- **A colour rename purges `products`, not a colour resource.** The dictionary is not a page;
  what changes is the name on every card, cart row and price-sheet row of that colour (I-f).
- **The purge goes after the derived writes**, never between them: a product rename rewrites its
  variants' names and slugs afterwards, and purging early would cache the half-renamed state for
  another hour.
- **A write that did not happen purges nothing.** Every call site sits after the `NotFound`
  check, so a PATCH that matched no document leaves the cache alone.

## The call

```
POST {FRONTEND_URL}/api/revalidate
Content-Type: application/json
x-revalidate-secret: {REVALIDATE_SECRET}      # only when the env var is set
{"resource":"products"}
```

- **Fire-and-forget.** `revalidate()` returns `void` and never rejects. A non-2xx or a timeout
  (3 s) is a warning in the log — `Storefront products revalidation after variant update failed
  (401)` — and the cached copy then expires on its own schedule. No admin save may fail because
  the storefront was unreachable.
- No `Origin` header is sent, which the frontend's same-origin check treats as a server caller.
- `Content-Type: application/json` is the frontend's CSRF control, not decoration.

## Bulk writes, and the throttle window

**This is the part to understand before adding a call site.** The Prom availability sync
rewrites stock and price for the whole catalogue, one variant at a time. A purge per write would
be hundreds of requests against a single Next process, each expiring the same coarse tag — a
storm with no benefit.

So the sender throttles per resource, with a **5 s window**:

1. the first write of a burst purges **immediately** — an ordinary single save is never delayed;
2. every write inside the window is remembered but not sent;
3. when the window closes, one **trailing** purge covers all of them, and re-opens the window, so
   a sync that is still writing stays at one purge per window instead of resuming one per write.

Worst case a bulk write is visible ~5 s late instead of up to an hour late. A quiet window
closes without sending anything, so an idle admin costs no requests at all.

The window lives on one process-wide instance (`storefrontRevalidation`), and services take it
through an `@Optional()` constructor parameter that defaults to it. That is deliberate: it is not
a registered provider, because a provider registered in three modules would be three throttle
windows — and a bulk write reaching the storefront through two of them is exactly the storm the
window prevents. If it is ever registered for real, register it **once**, in a `@Global()`
module. A spec passes its own instance instead.

### Known gap: the Prom sync itself

`PromSyncService` writes through `ProductVariantRepository.update` directly, bypassing
`ProductService`, so **a Prom sync currently purges nothing** — stock written by the 30-minute
job is still up to an hour behind on the storefront. Closing it is one call at the end of
`syncAvailability` (one request per run, which is stricter than the window):

```ts
this.revalidation.revalidate('products', 'prom availability sync')
```

`src/modules/prom/` was out of scope for the change that introduced this service; the line above
is the whole fix, and the throttle makes a per-write call safe too if that is ever preferred.

`LandingService` likewise still holds its own private copy of the request. It behaves
identically, so landings keep working as they always have; folding it into the shared service
removes the duplication and puts landing writes in the same window as the rest.

## Configuration

| Variable            | Where                    | Value                                                                             |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `FRONTEND_URL`      | backend (existing)       | the storefront origin the call goes to; a trailing slash is stripped              |
| `REVALIDATE_SECRET` | backend **and** frontend | the same ≥32-char secret on both; never `NEXT_PUBLIC_*`, never a Docker build arg |

Outside production the frontend accepts the call without a secret (localhost development), and
when the backend has none it sends no header — a supported state, not a misconfiguration. In
production the frontend answers 503 until its own secret is set and 401 when the two disagree.
Both show up as the warning above and nothing else: **an unset or mismatched secret degrades the
shop to the old one-hour staleness, it never breaks a save.**

## Limits (inherited from the frontend)

One storefront replica only: the tag manifest is a per-process in-memory map. Cloudflare's edge
cache is not touched by this call.
