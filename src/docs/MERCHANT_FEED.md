# Google Shopping feed

The backend publishes a Google Merchant Center product feed (TD-0006 §5.3) — a static RSS 2.0
document with `g:` attributes, rebuilt from the catalogue on startup and every hour, served from
memory. Bing Merchant Center and Meta Commerce Manager read the same format.

Module: `src/modules/feed/`. Working set: `ProductVariantRepository.findActiveForFeed()`.

## Endpoints

| Method | Path                                | Access | What                                                                     |
| ------ | ----------------------------------- | ------ | ------------------------------------------------------------------------ |
| `GET`  | `/feeds/google-shopping.xml`        | public | the feed — register this URL in Merchant Center                          |
| `POST` | `/feeds/google-shopping/regenerate` | ADMIN  | rebuild now, synchronous; returns the generation summary; 409 if running |
| `GET`  | `/feeds/google-shopping/status`     | ADMIN  | last summary without rebuilding, plus readiness, schedule, last error    |

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
4. A run that ends with **zero items** is a failure too, not a catalogue of nothing. The XML is
   not even built: the cache is left exactly as it was, the summary comes back with
   `ok: false` / `failure_reason: 'empty_feed'`, and the reason lands in both `summary.error` and
   `FeedStatus.last_error`. With a previous XML cached, Merchant keeps fetching that one and its
   `generated_at` does not move — `FeedStatus.summary` always describes the XML actually being
   served, so a refused run never replaces it. With nothing cached the state stays "not
   generated" and the public GET keeps answering 503. The trigger is not hypothetical: a
   catalogue-wide loss of the «Виробник» attribute excludes every variant, and a
   `findActiveForFeed` that returns nothing (a bad migration, an empty collection) would
   otherwise publish a valid, empty channel — the one document that delists the whole account.

The hourly job honours `RUN_CRON` like the Prom sync, with the same overlap guard
(`FeedService.isRunning`); `POST /regenerate` is the manual fallback and answers 409 while a
generation is running.

## Item mapping

| Feed field                                 | Source                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `g:id`                                     | `variant.sku`                                                                                                                                                                                                                                    |
| `g:item_group_id`                          | `variant.product_id` — groups the variants of one product; **only when the product has more than one active variant** (`findGroupedProductIds`, TD-0013 D04, owner 31.10) — a product without variation is sent without it, and the ID returns by itself when a second variant is activated|
| `title`                                    | the SKU name — see «Title» below; capped at 150 chars                                                                                                                                                                                                |
| `description`                              | `product.description.html` → `sanitizePlainText`, whitespace collapsed, capped at 5000; the title when empty (+ warning)                                                                                                                         |
| `link`                                     | `${FRONTEND_URL}/products/${slug}` — the page's canonical                                                                                                                                                                                        |
| `g:image_link` / `g:additional_image_link` | `images[0]` / `images[1..10]`, **original URLs** — the same ones Product JSON-LD uses, so feed and page agree                                                                                                                                    |
| `g:availability`                           | `in_stock` when `stock > 0`, else `out_of_stock` — underscored, as in Google's attribute reference                                                                                                                                               |
| `g:price`                                  | `"{price.toFixed(2)} UAH"` — the **regular** price. `prom_base_price` is never a «was» price: it is the supplier's figure                                                                                                                         |
| `g:sale_price` / `g:sale_price_effective_date` | only while the variant's promotion is on (`activePromo`, TD-0012): `"{sale_price.toFixed(2)} UAH"`, and when the promo has an end date the window `"{generatedAt}/{promo_ends_at}"` as `YYYY-MM-DDThh:mm:ss+00:00` (seconds kept — a window that dropped them could read `12:00/12:00` and be refused as a start that is not before its end). Open-ended promos send no window. The page's JSON-LD derives the same pair from the same rule, so Merchant never sees them disagree |
| `g:brand`                                  | v2: the linked brand entity, else the characteristic marked `semantic: brand` (hidden from the table or not) — never a label match; v1: the «Виробник» attribute via `pickAttr(MANUFACTURER_PATTERNS)` until the last v1 category is migrated. **Never `Vendor.name`** — the vendor is the supplier                                                                                                                             |
| `g:google_product_category`                | `category.google_product_category.id`; omitted (+ warning) when null                                                                                                                                                                             |
| `g:product_type`                           | `"{Category.name} > {Landing.h1}"` for the most specific active landing whose pinned filters the product matches, else the category name                                                                                                         |
| `g:condition` / `g:identifier_exists`      | constants `new` / `false` — no GTIN/MPN in this catalogue                                                                                                                                                                                        |
| `g:color`                                  | dictionary `color.name_uk`; `pickColor()` heuristic only where the dictionary has a gap                                                                                                                                                          |
| `g:material`                               | v2: only the characteristic marked `semantic: material` (the migration marks filament's `polymer`); v1: `materialOf()` (`polymer`, else `pickAttr(MATERIAL_PATTERNS)`) — the same function gives the product page's JSON-LD `material` (`semantic_values`), so page and feed agree                     |
| `g:shipping_weight`                        | `"{weight_g / 1000} kg"`; omitted (+ warning) when null                                                                                                                                                                                          |
| `g:product_highlight`                      | v2: the characteristics the product page's table shows, in its order, `«{label}: {value} {unit}»`, without the brand and the colour (fields of their own); v1 (until migrated): one bullet per stored spec dimension — diameter, weight, `polymer`, `finish`, `reinforcement`, `series`, `spool_included`; brand, colour and the legacy «Матеріал» are left out because each has a field of its own |
| `g:custom_label_0..3`                      | type family (see below) · manufacturer · stock depth (`deep` >10 / `low` 1–10 / `out` 0) · price band (`budget` <500 / `mid` ≤1500 / `premium`) — of the price the shopper pays, i.e. the sale price while a promo is on                        |
| `g:custom_label_4`                         | sales velocity from PAID orders of the last 90 days (`OrderRepository.countSoldByVariantSince`): `bestseller` ≥10 units · `popular` ≥3 · `standard`                                                                                              |

### Title

The SKU's own name, exactly as the site prints it — product name, then the variation:
«Kingroon PETG (CoPET) 3 кг — Філамент (пластик для 3D-друку) — Чорний (Black)» (owner,
2026-11-05). Nothing is composed in: no category name, no diameter or weight, no brand moved about.
The words shoppers search for belong in the name itself — the v2 migration writes «Філамент
(пластик для 3D-друку)» into every filament product and SKU name (`product_name_addition`), so the
title carries it. Capped at 150 characters with «…».

The composed title of 22.09.2026 (`{Категорія} {тип} {бренд} {діаметр} {вага} — {колір}`,
`buildTitle`) is removed: it was a filament rule applied to every category. Changing the rule changes
every item title at once, and Merchant re-reviews them (hours to ~3 days).

### Type family — `custom_label_0`

`basic` · `decorative` · `engineering` · `flex`, read from the TD-0002 dimensions rather than
from the product name:

| Family        | Rule                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `engineering` | `reinforcement` filled (CF/GF), or a legacy «Матеріал» value containing CF/GF, or `polymer` ∈ ABS, ASA, PA, PA6, PA12, PC, PET, PPA, PPS |
| `flex`        | `polymer` ∈ TPU, TPE                                                                                                                     |
| `decorative`  | `finish` filled — Silk, Matte, Wood, Glow, Luminous, Gradient, Rainbow, …                                                                |
| `basic`       | everything else — commodity PLA and PETG                                                                                                 |

Reinforcement is checked first: PLA-CF is engineering filament even though its polymer is the
commodity one. The label used to carry the category name, which is the same word on every row
while the shop sells one category — Shopping had nothing to subdivide by. **In Ads:** a product
group that was subdivided on the old constant value falls into "everything else" after the first
fetch of the new feed; re-subdivide on the four families.

**There is no margin label and no supplier value anywhere in the feed.** The first design had a
margin bucket in `custom_label_2`; it was dropped (owner, 2026-09-06) because the shop resells at
supplier price + margin, and the same `API_AND_SWAGGER.md` rule that hides `prom_*` from public
endpoints applies to the feed. Stock depth segments campaigns just as well and is already public.

### Exclusions (hard Merchant requirements)

| Reason              | When                                            |
| ------------------- | ----------------------------------------------- |
| `missing_brand`     | v2: no brand entity and no characteristic marked brand; v1: no «Виробник» attribute — no shop-name fallback |
| `no_images`         | no image URL                                    |
| `no_price`          | price missing or ≤ 0                            |
| `dangling_product`  | the variant's product is gone                   |
| `dangling_category` | the variant's category is gone                  |

DRAFT and ARCHIVED variants never reach the builder — `findActiveForFeed` matches `ACTIVE` only.
`stock = 0` is **not** an exclusion: the item stays with `out_of_stock`, so its history in
Merchant survives a stock-out.

### Warnings (item stays, Google lists it worse)

| Code                         | Raised when                                               | `unit`     |
| ---------------------------- | --------------------------------------------------------- | ---------- |
| `no_google_product_category` | the category has no `google_product_category`             | `category` |
| `no_description`             | `product.description.html` is empty — the title stands in | `item`     |
| `no_weight`                  | `variant.weight_g` is null                                | `item`     |
| `missing_required_attribute` | a category entry with `is_required: true` is unfulfilled  | `item`     |

Every category attribute has an explicitly stored boolean `is_required`. Entries with `false`
remain catalogue filters but do not produce completeness warnings. A missing/non-boolean flag
(or malformed attribute list) aborts regeneration and retains the previous in-memory XML.
There is no fallback for unmigrated records. Run the [full migration and verification](../../scripts/migrations/category-attribute-requiredness.md)
before deploying the strict backend/frontend contract; the migration covers all categories and
makes only `filament.finish` and `filament.reinforcement` optional initially.

This is where the category's `required_attributes` get visibility without enforcement on write
(TD-0006 §2).

**Unfulfilled means missing _or_ empty.** The admin form saves a required attribute left blank as
`{ k: 'diameter', l: 'Діаметр', v: '' }` — the key is present, so a key-presence check fires for
nothing the admin ever created, while TD-0006 §5.3 asks for "невиконаний `required_attributes`".
`isAttrValueEmpty` treats `undefined`, `null`, a blank string and an all-blank list as no value;
`0` and `false` are values and fulfil the requirement.

**What each counter counts.** Per warning:

- `count` + `unit` — affected entities in the unit of that kind, always read together.
  `no_google_product_category` counts **distinct categories**: one untagged category with forty
  variants is one thing to fix, and the admin screen's own label reads «1 категорія». Every other
  kind counts feed rows.
- `item_count` — feed rows carrying the warning, whatever `unit` says. Always present.
- `skus` — the first 20 affected SKUs.
- `detail` — `{ key: count }` for `missing_required_attribute`; kept unchanged for readers that
  only need numbers.
- `attributes` — `[{ key, label, count }]`, the same gaps with the label the screen prints
  («Діаметр», never `diameter`). The label comes from the category's `required_attributes`, falls
  back to the product's own `attributes[].l`, and only then to the key.

Per generation, `FeedGenerationSummary` also carries both totals explicitly, because they are
different numbers and summing `count` across kinds is neither of them:

- `warning_kinds` — distinct kinds present. This is the admin KPI «попереджень» (the mock shows
  four kinds, not the positions behind them).
- `warned_items` — feed rows carrying at least one warning, counted once each.

## Promotions and freshness (TD-0012)

A promotion changes what the feed must say without any admin touching the feed:

- **An admin write** (`PATCH /products/:id/promotion`, or a variant write that mentions
  `promo_percent` / `promo_ends_at`) raises `FeedRefreshSignal` (`src/common/services/feed-refresh.signal.ts`).
  `FeedCronService` subscribes on bootstrap — unconditionally, like the bootstrap run, because the
  XML cache is per process — and regenerates after a 5 s debounce. The product module never sees
  `FeedService` (FeedModule imports ProductModule, so it could not); it only says the feed is stale.
- **A promo that ends on its own date** is caught by `PromoExpiryCronService` (every 10 minutes,
  gated by `RUN_CRON`): `countPromosEndedBetween(lastTick, now)` > 0 → storefront purge +
  regeneration. Nothing is written to the database — the sale price is derived on read, so the
  documents are already right; only the caches were not.
- Every item in one generation decides its promotion against the same instant (`generatedAt`),
  which is also the feed's `Last-Modified`.
- A request that arrives while a generation is running is queued and honoured as soon as that
  run ends (`FeedService.requestRerun()`, run from `generate()`'s `finally`): the running one read
  the catalogue before the write and may publish exactly the state the request wanted gone. The
  queue lives in `FeedService`, not in the cron, because the admin's manual
  `POST /feeds/google-shopping/regenerate` calls `generate()` directly and the cron never sees it.
- These are best-effort freshness bounds, not guarantees: the signal is in-process (a replica that
  did not take the write rebuilds on its own hour), the expiry job runs on the one `RUN_CRON`
  instance, and Merchant fetches on its own schedule. The hourly run is the floor under all of it.
- A percent that rounds to no saving (sale price ≥ regular, or 0 — e.g. 1 % off 49 ₴) is no
  promotion anywhere: no `g:sale_price`, no badge. Merchant rejects a `sale_price` that is not
  lower than `price`. Rounding is half up on both sides (`floor(x + 0.5)`, not `$round`, which is
  half-to-even — 212.5 must be 213 on the page and in the catalogue filter alike).

## Where the numbers come from

- **Weight** — `ProductVariant.weight_g`, initially populated by the now-retired catalogue migration:
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

Unit: `google-shopping-feed.builder.spec.ts` (every field, every exclusion, every warning, an
empty required value counting as unfulfilled, the label fallbacks, no supplier value),
`product-type.resolver.spec.ts`, `feed.service.spec.ts` (cold start, summary, overlap guard,
failure keeps the last XML, a zero-item run refused with and without a cached XML, categories
counted once for the taxonomy gap). RBAC: `feed.controller.rbac.spec.ts` (public XML,
503 before the first generation, admin-only regenerate/status). Integration:
`product-variant.repository.int-spec.ts` — `findActiveForFeed` returns ACTIVE only and no supplier
field.

## General catalogue transition (local, 2026-10-24)

`pickColor` no longer falls back to an arbitrary variant value: it requires the legacy
colour axis label or an explicit colour attribute; dictionary colour still wins.
The title retains a non-colour variant suffix (e.g. current or size) independently
from `g:color`. Existing Ukrainian dictionary display is preserved. Category-specific
export/highlight/custom-label rules and full semantic v2 mapping are still pending;
current advertising campaigns have not been changed.

## Захист експорту під час переходу каталогу (локально, 24.10.2026)

FeedService перевіряє legacy read stamp до збирання даних і після формування XML,
безпосередньо перед синхронною публікацією кешу. Та сама перевірка діє для cron,
bootstrap, ручного rebuild і queued rerun. Збій зберігає попередні XML/дату/summary;
не публікується ні частковий, ні порожній XML. Опис каналу тепер нейтральний:
«Каталог товарів Fillando».

Кеш зберігає initialized/revision/epoch генерації. Публічний GET використовує
getVerifiedXml: busy/несумісний каталог дає 503, а інший initialized або revision — 503
CATALOG_FEED_STALE до успішної регенерації. Сам epoch фід не застарює (аудит 11.11.2026):
його без revision зсуває лише відхилена чи відкочена операція, а дані тоді ті самі, з яких
зібрано фід; до цього кожне збереження «без змін» давало Merchant 503 до перебудови. Такий запит сам ставить регенерацію в чергу
(`feedRefresh`, 5 с debounce, 29.10.2026): запис каталогу іншим процесом (CLI міграції
`apply`) не подає сигналу в API, а у вікні релізу `RUN_CRON` вимкнений — без цього
фід лишався 503 до рестарту чи ручної кнопки. На репетиції — знову 200 через ~6 с. Старий XML зберігається в пам’яті для
діагностики, але після зміни stamp не віддається. Maintenance/stale помилка має
Retry-After: 5 і Cache-Control: no-store; без першого XML чинний Retry-After: 60.
Стабільний download зберігає XML MIME, Last-Modified та max-age=300. Уже збережені
зовнішнім кешем відповіді потребують майбутнього purge/visibility release протоколу.
xml_ready у статусі означає наявність кешу, не live-перевірку його доступності.

Партнерські categories/skus/lookup/bulk availability/single availability тепер
використовують HTTP read barrier. POST читання явно позначені read-only та не
потрапляють під legacy write interlock. Auth/rate limit зберігаються перед читанням;
503 має Retry-After: 5/no-store. Чинні payload успішних відповідей не змінено.
Це узгодженість окремого запиту: revision-bound partner cursor між сторінками
ще не реалізований, як і typed v2/ancestor visibility adapters.

Ці зміни не активують v2. Legacy exports блокуються на несумісних категоріях.
Checkout, sitemap, direct partner service calls, external cache invalidation та
нові write API залишаються окремою роботою. Feed generation захищено на рівні
service, partner — на рівні HTTP interceptor.

## Typed catalogue rows (local, 2026-10-27)

With the tree in place the feed is an adapted reader: only SKUs of public categories are
exported, landings of public v1 categories type `product_type`, and v2 rows pass through
`feed-typed-adapter.ts` — typed specifications, the axis value as the variant label, never
a colour for an arbitrary axis, the brand from the «Виробник» characteristic or a linked brand
entity (no vendor fallback; without a brand the SKU is excluded as `missing_brand`; corrected
30.10 — brands as entities are out of scope, owner 29.10). Of the category feed settings only the Google
taxonomy exists (below). Not live.

Since the filament rehearsal (2026-10-27): the adapter passes bare values (the builder adds
units from `required_attributes`), keeps the dictionary colour for a colour axis, and typed
(`filters_v2`) landings of v2 categories still type `product_type` (by their own pins since the
31.10 audit — below). On the migrated stand all
301 filament SKUs are exported with the legacy title rule («Філамент PETG (CoPET) 3 кг Kingroon
1.75 мм — Чорний»); v2 SKUs without a brand entity are excluded as `missing_brand`.

*Corrected 30.10 (Plan-0010 D06.1):* a v2 SKU's brand is its **«Виробник» characteristic** — a definition visible
in the specification, which the migrated filament has (mapping `brand_key: null`) — read by the builder's
«Виробник» label rule; a linked brand entity is added only where one exists (brands are out of the Plan-0010
scope, owner 29.10). A v2 SKU is excluded as `missing_brand` only when it has neither. *02.11 (P04):* where a
product has both, the brand entity wins — the same rule as the product page and the price sheet, so `g:brand`
equals the page's JSON-LD `brand` (`feed-typed-adapter.spec.ts`).

## Category Google taxonomy (local; Plan-0010 B10)

A v2 product category carries one feed setting, its `google_product_category`, edited in the admin card «Google
Shopping» through `GET/PATCH /categories/:id/admin/export` (ADMIN, `Idempotency-Key`, `expected_revision`;
journal profile `export`; `{id, path}` or `null`, only the id is sent — the path is an admin note; a save
requests an early feed rebuild). A category without it gets no `g:google_product_category` and a warning per
item. Migrated filament keeps the 499682 it had.

**Removed (owner, 04.11.2026):** per-category title keys, highlight keys and static custom labels
(`export_rules`, 28.10). They made the admin harder to read without a use: the title and the highlights
follow the one feed rule above for every category, the custom labels are always the computed ones, and
Google Ads can already split campaigns by `product_type` (category or landing) and by the Google category.
Checked on the 02.11 production dump: legacy feed (old code) = legacy feed (new code) = feed after the v2
migration = feed after its revert, 301/301 items byte for byte (lastBuildDate and sale windows aside).

Independently of the taxonomy, the typed adapter fills `semantic.size` / `semantic.material` from the
definitions with that `semantic` (the product value, or the SKU's axis value when the axis carries it); the
builder prints `g:size` and lets the material semantic win over the polymer rule. Colour stays the
dictionary colour of a colour axis only. Tests: `google-shopping-feed.builder.spec.ts` (v2 rows),
`catalog-exports.int-spec.ts` (size and computed labels through `FeedService`), `category-export.int-spec.ts`
(the writer).

## Memory at 100 000 SKUs (Plan-0010 D06, local)

**29.10:** `generate()` read every active SKU with its product and category in one `findActiveForFeed()` array and
kept the built XML in the process. On the synthetic 10 020-category / 100 000-SKU catalogue the bootstrap run alone
peaked at **518 MiB RSS** (Linux container, 400 MB heap) — with no item published (the fixture had no photos).

**30.10 — streamed generation (D06.1).** Same output, a different shape of work:

- **Working set from a cursor.** `findActiveForFeed()` is an aggregation cursor (`batchSize` 100), not an array; the
  SKU order is applied first (`$match` + `$sort {sku}` before the joins, served by the unique `sku` index), which is
  the order sorting the joined rows gave. Small batches on purpose: a batch is deserialised at once and lives while
  its rows are built, and under concurrent catalogue reads 500 rows a batch survived into V8's old generation.
- **No item list, no document string.** Each item is handed (in ~64 KiB slices) to a gzip stream as soon as it is
  built; the artifact is `{ gzip, bytes, generatedAt }` (`FeedArtifact`). `feedXmlHead` + items + `FEED_XML_TAIL`
  is byte for byte `buildFeedXml(items)`.
- **The GET serves the same bytes with the same headers:** `Content-Type`, `Last-Modified`, `Cache-Control` and an
  explicit `Content-Length` (what `res.end(xml)` set implicitly), the body inflated while it is sent — never the
  whole document in memory, no `Content-Encoding`, no chunked transfer.
- **Exclusions are counted, not listed in full.** `summary.excluded` is the first `FEED_EXCLUSION_SAMPLE` (500)
  exclusions in SKU order — every one of them on any real catalogue — plus `excluded_count` and
  `excluded_by_reason`. The admin screen counts from `excluded_count` (falling back to the list for an older
  backend) and says «Показано перші N з M» when the list is a sample.
- **Categories without content.** Visibility and the attribute contract come from the light public tree
  (`CategoryPublicReadService.productCategories()`); the definitions of v2 categories are read per row batch
  (`contentOf(…, { cache: false, of })` — against the same tree, past the storefront's content cache) and at most 500
  of them are kept during a generation.
- Unchanged: the stamp check (`getVerifiedXml` → 503 + `feedRefresh`), the zero-item refusal, the queued rerun,
  `FeedRefreshSignal`, bootstrap + hourly generation, the status screen.

Parity: `feed-streaming.int-spec.ts` — on a mixed catalogue (v1/v2, a hidden branch, colour and numeric axes,
promotions open-ended/dated/ended/rounding to nothing, zero/negative/missing stock, every exclusion reason, v1 and
typed landings for `product_type`, sales velocity, 600+ items so the compressor flushes many times) the streamed XML
equals the former generation (one array, the former reader, joined items) byte for byte at the same instant, with
the same summary; over HTTP the same bytes and headers. Stand (`fillando_catalog_local_v2`, 301 items): the feed
before and after the change is identical apart from the generation dates, header set identical.

Measured (Linux container `node:24-alpine`, 400 MB heap, synthetic catalogue with photos and the visible «Виробник»
characteristic — 100 000 real items, 198 MB of XML kept as 5.6 MB): bootstrap generation alone 58 s, VmHWM 317 MiB;
bootstrap generation overlapped by 10 concurrent catalogue readers for 5 minutes — VmHWM 484 MiB (target ≤ 512 MiB).
Numbers and history in the Plan-0010 M0 evidence (30.10).

## Audit 31.10.2026 (local)

- **An old SKU address loses its query** (owner decision 31.10: documented, code unchanged). After a SKU slug change
  (`POST /routes/variants/:id/slug-change`) the storefront answers the old `/products/{old}` with one 308 to the new
  address, but without the query string: the product page is ISR and does not read `searchParams`. Until Merchant
  fetches the feed with the new `link`, a Shopping click on the old URL arrives without its `gclid`/`utm_*`, so that
  window's clicks are not attributed. Category and landing redirects keep the query. TD-0013 SEO matrix, row
  «Старий URL».

- **`product_type` of typed landings.** A typed landing (`contract_version: 2`) refines `product_type` by its own
  pins (`filters_v2.attributes` — discrete values or a numeric range, `typedLandingPins`) against the product's typed
  values (`attributes_v2` plus the SKU's axis value), the storefront's listing rule; no longer by the legacy `filters`
  a migrated landing kept. A landing created in the new admin (`filters: {}`) used to never type, and a re-pinned
  migrated one typed by its stale pins. A landing that also pins colour families, price, stock, categories, brands
  or products does not refine the type (never a type the storefront does not list it under). Migrated filament
  landings carry the same pins in both forms: the stand feed is the same XML (apart from dates). Tests:
  `product-type.resolver.spec.ts`, `feed-streaming.int-spec.ts` (fixture `avr-63` now a valid range pin).
- **Rebuild after every catalogue operation.** `CatalogWriteGate.finishPublication` raises `FeedRefreshSignal` for
  completed, aborted and rolled-back operations alike: a completed one moves the revision the feed is served under
  (503 `CATALOG_FEED_STALE` until its next GET or the hourly run — publication, typed landings, storefront
  settings, SEO and presentation did not ask for it), and any of them discards a generation it overlapped. Since
  the 11.11 audit only a revision makes the served feed stale — an aborted or rolled-back operation moves the epoch
  alone and leaves the data the feed was built from.
- **`g:item_group_id` only for a group** (owner decision 31.10, TD-0013 D04): sent when the product has more than
  one ACTIVE variant (one `$group` over active variants before the stream), never for a product with a single
  active variant; multi-variant products are unchanged. Ships with the release (R02), no separate deploy; on the
  stand 11 single-SKU products lose the tag. Tests: `google-shopping-feed.builder.spec.ts`, `feed.service.spec.ts`,
  `product-variant.repository.int-spec.ts` (`findGroupedProductIds`), `feed-streaming.int-spec.ts`.

