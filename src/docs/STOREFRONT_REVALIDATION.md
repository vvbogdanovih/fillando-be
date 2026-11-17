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

- **Fire-and-forget.** `revalidate()` returns `void` and never rejects. No admin save may fail
  because the storefront was unreachable.
- **Kept until acknowledged — the outbox** (P12, owner decision 02.11.2026; TD-0013 catalog
  mutations §4). The app attaches the shared instance to MongoDB at start
  (`StorefrontPurgeOutbox`, `src/common/services/storefront-purge-outbox.ts`), and from then on a
  request is a document in `storefront_purges`, one per resource: `_id` (the resource), `triggers`
  (for the log line), `version` (bumped by every request), `due_at`, `attempts`, `lease_until`,
  `echo`, `last_sent_at`, `last_error`. A poll (every 1 s, and right after a request) claims a due
  document with a 30 s lease — two backend processes never send the same purge — and posts it.
  Only a **2xx** removes it: no answer, a timeout (3 s), a 401 from a wrong secret, a 5xx — all
  keep it, retried after 2 s, doubling up to 5 min, with a warning on the 3rd and every 10th try
  that names what stays stale — `Storefront categories revalidation after category seo not
  acknowledged after 3 attempts: 503 … — kept in the outbox, retried every 8 s; stale until then:
  /catalog, /{category}, /{category}/{landing}, /products/{slug}, the header menu, /sitemap.xml`.
  The purge survives a restart of either side: the next process delivers what the last one left.
  A delivery clears only the version it carried; a request that arrived during the call stays due.
- **The echo** (P15): an acknowledged purge is sent once more 10 s later, then the document is
  removed. A page render that read the old data just before the purge and wrote its cache entry
  just after it would otherwise serve the old copy for its hour; the echo expires that entry too.
  The release E2E saw the header menu stay stale once (01.11) and never reproduced it — the cause
  is not established; the echo closes that window whatever the cause.
- **Without the outbox** (a process that never attached one: scripts, unit tests; or MongoDB
  failing the request itself, logged as `not queued`): the old path — sent now, 3 attempts 2 s
  apart for no answer / 429 / 5xx, then one warning; the cache then expires on its own (up to 1 h).
- No `Origin` header is sent, which the frontend's same-origin check treats as a server caller.
- `Content-Type: application/json` is the frontend's CSRF control, not decoration.

## Bulk writes, and the throttle window

**This is the part to understand before adding a call site.** The Prom availability sync
rewrites stock and price for the whole catalogue, one variant at a time. A purge per write would
be hundreds of requests against a single Next process, each expiring the same coarse tag — a
storm with no benefit.

So the sender throttles per resource, with a **5 s window**:

1. the first write of a burst purges **immediately** — an ordinary single save is never delayed;
2. every write inside the window joins the one pending document (its trigger, a new version);
3. it is due when the window after the last delivery closes, so a sync that is still writing
   stays at one purge per window instead of resuming one per write.

Worst case a bulk write is visible ~5 s late instead of up to an hour late. Nothing is sent
without a request (and its one echo), so an idle admin costs no requests at all. A purge waiting
out a failure keeps its retry time when a new request joins it.

The window is in the outbox, so it holds across processes too. The sender is still one
process-wide instance (`storefrontRevalidation`) that services take through an `@Optional()`
constructor parameter defaulting to it, and `StorefrontPurgeModule` (`@Global()`, imported once in
`AppModule`) only attaches it to the database — it is not a provider anyone injects. A spec
passes its own instance; the outbox spec (`storefront-revalidation.outbox.int-spec.ts`) attaches
instances to a test database with short timings and a local HTTP server as the storefront.

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
Both show up as the warning above and a document that stays in `storefront_purges` (retried every
5 min at most) — nothing else: **an unset or mismatched secret degrades the shop to the old one-hour
staleness, it never breaks a save**, and the owed purges go out once the secret is fixed.

## Limits (inherited from the frontend)

One storefront replica only: the tag manifest is a per-process in-memory map. Cloudflare's edge
cache is not touched by this call.

## A sibling: the Merchant feed signal (TD-0012)

`src/common/services/feed-refresh.signal.ts` is built the same way — a module singleton taken
through an `@Optional()` constructor default, fire-and-forget, debounced (5 s) — but it tells the
process's own `FeedCronService` to rebuild the Google Shopping feed rather than the storefront to
drop a tag. `ProductService` raises it after a promotion write; `FeedModule` imports `ProductModule`,
so an injection in the other direction would be a cycle. Promotions that end on their own date are
handled by `PromoExpiryCronService` in `FeedModule`, which calls both this service and the feed.
