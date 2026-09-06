# Catalogue release — deploy and migration order

How to take Plan-0003 and Plan-0004 from `dev` to production. Written because the ordering
rules were spread across two `CLAUDE.md` files, a plan document and several commit messages,
and getting one of them wrong is visible to every visitor.

Everything below is already merged into `dev` in both repositories and **not deployed**.

---

## 0. Before you start

Four decisions are still open. None of them blocks the deploy, but each one leaves something
half-finished until it is made.

| # | Decision | Consequence of leaving it |
| --- | --- | --- |
| 1 | ~~One product has an empty `material`~~ — **handled by step 3a** since 2026-09-05. | Nothing to decide. `fix-known-data-defects.js` sets `Матеріал = PETG` on Kingroon PETG (CoPET) 3 кг and repairs its `category_id`, which was stored as a string. |
| 2 | **49 colour spellings** the dictionary cannot identify, listed in `scripts/fillando_v_2/reports/color-report.json` after a dry run. | Those variants keep their current Ukrainian value and stay out of the colour filter. Nothing breaks; the filter is simply less complete. |
| 3 | ~~The refill is a variant, not a product~~ — **handled by step 3d** since 2026-09-05. | Nothing to decide. `split-refill-products.js` moves FL-000253 onto its own product; the only manual step left is rewriting that product's description, which it inherits from the parent. |
| 4 | **Two 'Candy' variants sit on one product** — `FL-000157` (₴890, stock 50) and `FL-000162` (₴860, stock 60) on *Kingroon PLA Silk Rainbow*, same `v_value`, different prices and `prom_id`s. A Prom-import duplicate that predates the taxonomy work. | The only thing left that a script cannot settle. They are the two variants the colour migration leaves unmatched, because one product cannot give two variants the same colour without colliding on the slug, and renaming the product is refused with a 409. Open both in the admin, give the second the colour it actually is, or archive it; then re-run steps 3f and 3i. |

The same product as #1 also carries `category_id` as a **string** rather than an ObjectId. It is
harmless today (its variant has the right type), but any future query that filters products by
`category_id` must compare with `$toString` or it will silently skip this one.

Find every latent pair of #4's shape before the deploy. A rename regenerates all of a product's
slugs at once, so two variants whose values collapse to the same slug block that product. Collide
on the generated slug, not on `v_value` — different values can still slugify to one address:

```js
// node, from the backend project root, against production
const { generateSlug } = require('./dist/common/utils/attribute.utils')
// for each product, group its variants by generateSlug(`${product.name} ${v.v_value}`)
// and report every group holding more than one SKU
```

On `fillando-dev` this reports exactly one group: `FL-000157 + FL-000162`.

---

## 1. Deploy the backend

`dev → main`, then the server (see `fillando-meta/docs/runbooks/deploy-backend-lxc.md`).

Ships: RBAC on write endpoints, the public projections, rate limiting, the payment-status
lookup, `ATTR_KEY_OVERRIDES`, the `colors` and `landings` modules, the colour filter, and the
colour payload on every public product response.

**Merging is deploying.** `.github/workflows/deploy.yml` fires on every push to `main`: it pulls
`main` on the LXC, rebuilds the image with `--no-cache` and restarts the container. Have
`.env.prod` and the checks below ready before clicking merge, not after.

`INTERNAL_API_TOKEN` is **optional and should stay out of `.env.prod` for now.** The schema is
`z.string().min(32).optional()` (`src/common/constants/env.constant.ts`): an unset key means
"nothing is exempted" and is safe, but an **empty `INTERNAL_API_TOKEN=` line fails validation and
the API does not boot** — check the file for exactly that line before deploying. The frontend on
`dev` never sends `X-Internal-Token` (no `serverFetch` call hits a throttled endpoint, so it does
not need to), so setting the token buys nothing today.

**Rate limiting keys on `req.ip`** (the `@nestjs/throttler` default tracker) with `trust proxy 1`
in `main.ts`, i.e. the address the **last** proxy saw. Production sits behind Cloudflare
(`server: cloudflare` and `cf-ray` on `api.fillando.com`) in front of Nginx Proxy Manager, so
unless NPM restores the client address from `CF-Connecting-IP` (`set_real_ip_from` the Cloudflare
ranges + `real_ip_header CF-Connecting-IP`), `req.ip` is a Cloudflare edge address and every
visitor behind that edge shares one bucket. The visible symptom is a `429` on `POST /auth/refresh`
(30/min), which the frontend answers by logging the user out. Check the NPM host config before
the deploy; if it does not restore the real IP, fix it there or add a `getTracker` that reads
`CF-Connecting-IP` before relying on the limits.

**Verify:** `docker logs fillando-be` shows a clean boot; `/swagger` lists `/colors` and
`/landings`; `GET /colors` answers 200 with `[]`; `GET /landings/admin` answers 401 without a
token. Plan-0003 checks: with a USER cookie `PATCH /products/:id` → 403 while the admin creates a
product → 201; `GET /products/by-slug/<slug>` carries no `prom_id` / `vendor_product_sku`; a draft
variant slug → 404; `GET /products/price-sheet?q=<vendor sku>` → empty; the 11th `POST /auth/login`
within a minute → 429 with `Retry-After`; `GET /orders/lookup` with a wrong token → 404 and with
the right one → the four public fields only.

---

## 2. Deploy the frontend

`dev → main`, then the server.

Same mechanism: the push to `main` builds the image on the frontend LXC. **The build talks to the
live API** — on `dev`, `serverFetch` throws on failure and `next build` pre-renders pages and the
sitemap from `NEXT_PUBLIC_API_BASE_URL`, so the build fails outright if `api.fillando.com` is
down and ships a stale sitemap if the backend is still the old one. Merge the frontend only after
step 1 is verified live.

This step is not optional before step 3i, and it is the one that is easy to postpone: the
storefront must be rendering `color` **before** the colour migration rewrites `v_value` to the
English name. Deploying the backend alone and running 3i would switch the whole Ukrainian shop
to English colour names.

**Verify:** a product page still shows its Ukrainian colour; `/filament?page=2` is reachable by
clicking, and its links are real `<a href>`; the header lists categories fetched from the API;
`sitemap.xml` carries the legal pages and `/price-sheet` and no draft SKU. LiqPay sandbox
(Plan-0003 §6): success → «Дякуємо» and exactly one Google Ads conversion; declined card →
«Оплата не пройшла» and no conversion; window closed → PENDING with polling and no conversion;
`initLiqpayCheckout` failure → toast and the success page with an «Оплатити» button.

---

## 3. Migrations

**Where they run.** The production image has no `scripts/` directory (the `Dockerfile` copies
only `dist`, `package.json` and production `node_modules`) and the LXC has Docker but no Node, so
`node scripts/…` on the host does not work. Run each script in a one-off container from the
checkout GitHub Actions keeps at `/srv/fillando-api`, with `scripts/` bind-mounted:

```bash
cd /srv/fillando-api            # already on main after the deploy
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -v "$PWD/scripts:/app/scripts" api \
  node scripts/fillando_v_2/normalize-attr-keys.js --dry-run
```

`env_file: .env.prod` gives the container `DATABASE_URL` (the scripts call `dotenv.config()`,
which never overrides a variable that is already set); `mongoose` and `dotenv` are production
dependencies already in the image; `normalize-variant-colors.js` finds `./seed-colors.js` through
the same mount; and reports land in `scripts/fillando_v_2/reports/` **on the host** (gitignored).
The §0 slug-collision check runs the same way — `dist/` is inside the image. The `node
scripts/fillando_v_2/…` lines below are what goes after `api` in that invocation.

**Rehearse on a dump before you touch production.** `rehearse-on-dump.sh` restores a
`mongodump` into the disposable MongoDB from `docker-compose.test.yml`, runs the whole chain
against it and prints the state before and after. It restores only the catalogue collections,
so customer data never leaves the dump, and it writes its reports to a temporary directory so
they cannot be mistaken for a real run:

```bash
yarn migrate:rehearse ~/Desktop/db_backup_for_test
```

Last rehearsal against a production dump, 2026-09-05: the chain applied cleanly, converged on
the second pass, and a third dry pass planned no changes. Every number quoted below is measured
from that run rather than estimated.

`verify-catalog-state.js` is the report it uses, and it writes nothing, so it is also the thing
to run against production right after the real migration:

```bash
yarn migrate:verify
```

**Everything that migrates catalogue data lives in `scripts/fillando_v_2/`, and one command runs
all of it.** The order below is what `run-all.js` encodes; getting it wrong by hand is easy, so
do not invoke the ten scripts individually.

```bash
yarn migrate --dry-run      # read every plan, writes nothing
yarn migrate                # apply; the colour step is held back
yarn migrate --colors-only  # after the frontend is live
```

It prints which database it is about to change before it starts, and an apply on a terminal asks
for confirmation: `yarn migrate` follows `.env`, which on a laptop is the shared dev database
rather than production. `--yes` skips the question.

An apply makes two passes. Steps after the taxonomy append attributes to products while the
taxonomy rebuilds its derived entries into a canonical order, so the first pass leaves a few
products merely ordered differently from what it would write; the second settles that and
reports nothing to do. Verified on a disposable database: a third pass plans no changes at all.

In a dry run each step reads the state as it is now, so a later step shows what it would do
*before* the earlier ones have run. Read each plan for its own step, not as a forecast of the
whole chain.

**Every script also takes `--dry-run` on its own and prints its full plan before it writes
anything.** Each is idempotent, so a re-run after a fix is safe.

### 3a. `fix-known-data-defects.js`

```bash
node scripts/fillando_v_2/fix-known-data-defects.js --dry-run
node scripts/fillando_v_2/fix-known-data-defects.js
```

Repairs the individually known broken documents rather than applying a rule. The catalogue is
frozen while this work lands, so the broken set is closed and inspected: on current data it is
two fixes, both on *Kingroon PETG (CoPET) 3 кг* — an empty `material`, which kept it out of the
taxonomy, and a `category_id` stored as a string, which drops it from any query matching
products by category.

Each fix names its document by `_id` and asserts what it expects to find there, so a changed
catalogue makes the run stop rather than write the wrong thing.

It also reports, without touching, the one defect a script must not guess at: the two "Candy"
variants of decision 4 above.

Expect on current data: 2 fixes applied, the Candy pair reported.

### 3b. `normalize-attr-keys.js`

```bash
node scripts/fillando_v_2/normalize-attr-keys.js --dry-run
node scripts/fillando_v_2/normalize-attr-keys.js
```

Renames attribute keys stored before `ATTR_KEY_OVERRIDES` existed. On the current data it
reports **"Nothing to do."** — it is a safety net for keys created through the admin between
the code deploy and this run, not a required step.

Must run **after** step 1, never before: the override table has to be live, or the next admin
save regenerates the transliterated key.

### 3c. `derive-material-taxonomy.js`

```bash
node scripts/fillando_v_2/derive-material-taxonomy.js --dry-run
node scripts/fillando_v_2/derive-material-taxonomy.js
```

Writes `polymer` / `finish` / `reinforcement` / `series` on every product from its `material`,
which stays as the marketing name, and swaps `material` for those four in the category's
`required_attributes`.

Expect on current data: 42 products changed, 1 category changed, 1 unmatched value (the empty
`material` from decision 1). Derived: polymer on 43 of 44 products (PLA 24, PETG 9, PA6 3, ABS 3,
TPU 2, ASA 1, PET 1), finish on 16, reinforcement on 8 (CF 7, GF 1), series on 43.

**Verify:** the script's own `Verify:` block is all `OK`; `/filament` shows the four new filters
and no longer shows «Матеріал».

### 3d. `split-refill-products.js`

```bash
node scripts/fillando_v_2/split-refill-products.js --dry-run
node scripts/fillando_v_2/split-refill-products.js
```

Moves every refill variant onto a product of its own. On current data that is one variant,
FL-000253 "Clear Безбарвний Refill", which sits on the Bambu Lab PETG Translucent product beside
eight spooled colours. It creates `<parent name> (без котушки)`, copying the parent's category,
vendor, description, variant axis and attributes, and marks it `Котушка в комплекті = Ні (рефіл)`;
the parent gets `Так`.

It also strips the word "Refill" from the variant's `v_value`, because the product name now
carries the distinction. That is what lets step 3i resolve the colour: while the marker lived in
the colour value, the normaliser had to skip the variant to avoid erasing it. For the same reason
the suffix is `(без котушки)` and not `Refill` — `isRefillVariant` reads the variant name, and the
variant name is built from the product name.

The variant's address changes and there is no 301, so the move is recorded in
`reports/slug-map.json` alongside the colour migration's moves. Target slugs are checked for a
clash before the first write.

Expect on current data: 1 product created, 1 variant moved, parent keeps 8 spooled variants.

**Verify:** `reports/refill-split-report.json`; `/filament/refill` stops matching zero products;
the new product opens in the admin. Its description was copied from the parent, so rewrite it.

### 3e. `backfill-spool-included.js`

```bash
node scripts/fillando_v_2/backfill-spool-included.js --dry-run
node scripts/fillando_v_2/backfill-spool-included.js
```

Gives every product `spool_included = Так`, then adds the filter to the category. Products
first: a category offering a filter no product carries returns an empty catalogue, whereas the
reverse is invisible.

Expect on current data: 42 products changed, 1 category changed, nothing skipped — step 3d has
already separated the one refill. The end state is `Так` on 43 products and `Ні (рефіл)` on 1.

It **skips and reports** the product that holds the refill variant (decision 3), because no
single product-level value is true for it.

### 3f. `seed-colors.js`

```bash
node scripts/fillando_v_2/seed-colors.js --dry-run
node scripts/fillando_v_2/seed-colors.js
```

Inserts 103 dictionary colours. The 47 added on 2026-09-05 exist to cover the spellings this
catalogue actually stores: the Dual-Silk and Tri-Silk gradients, the numbered Sunlu rainbows,
the thermochromic pairs and the one-off finishes. A spec asserts every one of them still
resolves, so an edit here cannot silently drop a product out of the colour filter. Non-destructive: an existing colour matched on `name_en` is left
untouched, so a hex tweaked in the admin survives a re-run.

### 3g. `seed-landings.js`

```bash
node scripts/fillando_v_2/seed-landings.js --dry-run
node scripts/fillando_v_2/seed-landings.js
```

Creates the 14 landings **as drafts** and prints how many variants each would list. On current
data, after step 3d, **all fourteen list something**:

| landing | variants | | landing | variants |
| --- | ---: | --- | --- | ---: |
| `/filament/pla` | 180 | | `/filament/pla-silk` | 24 |
| `/filament/petg` | 72 | | `/filament/pla-matte` | 18 |
| `/filament/abs` | 26 | | `/filament/carbon` | 13 |
| `/filament/asa` | 3 | | `/filament/pla-cf` | 8 |
| `/filament/tpu` | 14 | | `/filament/petg-cf` | 2 |
| `/filament/nylon` | 4 | | `/filament/wood` | 5 |
| | | | `/filament/glow` | 8 |
| | | | `/filament/refill` | 1 |

A landing that lists 0 must not be published.

Must run after 3c and 3e — its filters key off the dimensions those create.

### 3h. `fill-landing-copy.js`

```bash
node scripts/fillando_v_2/fill-landing-copy.js --dry-run
node scripts/fillando_v_2/fill-landing-copy.js
```

Writes the reviewed landing copy from `scripts/fillando_v_2/landing-copy.js`: `h1`, `title`,
`meta_description`, the intro, the SEO body and the FAQ for all fourteen. Every landing stays
**draft** — the script never publishes, because two of them still match nothing (see below) and
because deciding a page is ready for Google is a person's call.

It refuses to run on copy that would not survive `sanitizeRichText`, since writing straight to
Mongo skips the API's sanitizer. It also never overwrites text edited in the admin: only a draft
whose copy is still empty is filled, so a re-run after hand edits reports them and moves on.

Expect on current data: 14 filled, 0 skipped, with `refill` flagged as matching no products.

**Verify:** `reports/landing-copy-report.json` lists every landing with its match count; open two
or three in `/admin/landings` and read the text before publishing anything. Check `petg-cf`
first: its two SKUs (FL-000180, FL-000231) reach the landing only if their `material` reads
exactly `PETG-CF`, the key step 3c maps to `polymer: PETG` + `reinforcement: CF`. A different
spelling leaves the page empty and lands in the unmatched list of `taxonomy-report.json`.

### 3i. `backfill-variant-weight.js`

```bash
node scripts/fillando_v_2/backfill-variant-weight.js --dry-run
node scripts/fillando_v_2/backfill-variant-weight.js
```

Sets `weight_g` on every variant whose weight is still `null`: the product's «Вага» attribute
(kilograms in this catalogue) converted to grams, plus a **220 g spool** unless the variant is a
refill. The spool figure is an assumption in the middle of the 200–250 g range for a 1 kg reel;
the report names any heavier reel so a person checks it. A variant with no readable weight stays
`null` and is listed — the delivery estimate, the JSON-LD and the feed then omit the weight rather
than guess. Weights typed in the admin are never overwritten.

Expect on current data: 301 variants weighed from the attribute, 0 unmatched, the one 3 kg reel
flagged for a manual check.

**Verify:** `reports/weight-report.json`; open a few variants in `/admin/products` and read
«Вага, г». The delivery block on a product page shows a figure only once this has run.

### 3j. `normalize-variant-colors.js` — the risky one

**Do not run this until steps 1 and 2 are both live in production.** It rewrites `v_value` to
the canonical English name; until the storefront renders `color` instead, the shop displays
English colour names.

```bash
node scripts/fillando_v_2/normalize-variant-colors.js --dry-run
# read scripts/fillando_v_2/reports/color-report.json, then:
node scripts/fillando_v_2/normalize-variant-colors.js
```

Expect on current data: 291 of 293 colour variants matched (99%) and 8 variants off the colour
axis. The refill is no longer skipped: step 3d moved its marker onto the product name, so its
colour resolves like any other. The two variants left unmatched are both stored as "Candy" on
one product and need a person to tell them apart, see step 3a. **A slug collision aborts the run** rather than
half-applying it — resolve it (rename a variant, or split the dictionary entry into two
colours) and re-run. `--force` applies everything else and
leaves the collisions for later; use it deliberately, not to get past the message.

Variant **slugs change without a 301** — the owner's decision. `reports/slug-map.json` records
every old → new address and is merged across runs, never truncated, so it survives a re-run.

**Verify:** a migrated product page shows "Чорний (Black)"; the colour filter offers swatches;
`reports/color-report.json` has the unmatched list for the manual pass.

---

## 4. After the migrations

1. Mark the refill by hand: `Котушка в комплекті = Ні (рефіл)` on the refill product, once
   decision 3 is made.
2. Read the copy step 3h wrote, correct it in `/admin/landings`, and publish the landings one by
   one. A landing stays a draft until a person has read its text, and one that matches no
   products is never published — an empty SEO page in the index is worse than no page. On current
   data that rules out `refill`: the refill is still a variant inside another product, decision 3
   above.
3. Work through `color-report.json`: add a synonym to `seed-colors.js` for each spelling worth
   mapping, then re-run 3f and 3i. Both are idempotent.
4. Resubmit the sitemap in Search Console — it now carries the legal pages, the price sheet and
   the published landings.

**Editing a migrated product is safe from here on, and this is worth knowing why.** 3i writes
`v_value` as the English `colors.name_en` but the display `name` as `"<product> — Чорний (Black)"`
— Ukrainian first, the manufacturer's own spelling in brackets.
`ProductService` builds `name` from the dictionary whenever the variant points at it and falls
back to `v_value` only for variants without a colour, so re-saving a product reproduces the name
it already had. Before that, every save regenerated the name from `v_value` and quietly renamed
the variant to English — on current data 243 of 301 variants, one admin edit at a time, visible
in the catalogue listing, the `ItemList` markup, the cart rows and the price-list PDF (where the
variant name is also the sort key). The slug is still built from `v_value`, so addresses do not
move.

Renames are handled in three parts, and only an actual change of name triggers any of them — the
admin form posts `name` on every save, so keying off its presence would re-plan on edits that
have nothing to do with it:

1. The whole batch is planned and vetted **before the first write**. Two variants of one product
   heading for the same slug get a 409 naming both SKUs, as does an address already held by
   another product. Previously the duplicate surfaced partway through `Promise.all` as an
   unhandled `E11000`, which — with no transaction available on a standalone MongoDB — left the
   product renamed and only some of its variants rewritten.
2. Slugs can **rotate** within a product: the address one variant is moving to may still belong
   to a sibling that is moving too. That is not a conflict, but it is a race, so the writes go in
   two passes — every mover is parked on a temporary `…-moving-<id>` address first, which empties
   the target range before anyone claims it.
3. Variants whose slug does not change are written once, in the second pass.

---

## 5. Rollback

| Step | How to undo |
| --- | --- |
| 1, 2 | Redeploy the previous image. No data changed. |
| 3a | The previous values were an empty `material` and a string `category_id`; restoring them serves no purpose. |
| 3b–3c | No automatic undo. The derived attributes are rebuilt from `material` on every run, so a corrected mapping table is simply re-applied; removing them entirely means a one-off script. |
| 3d | Move the variant back with `$set: { product_id, v_value, name, slug }` from `reports/refill-split-report.json`, then delete the product it created. Nothing else referenced it. |
| 3e | No automatic undo; re-running rebuilds the attribute from the same rule. |
| 3f | Delete the inserted colours — the API refuses while variants reference them, which is the safety you want. |
| 3g | Delete the landings; they are drafts and invisible until published. |
| 3h | Clear `intro_html` / `bottom_html` / `faq` on the landings; they are still drafts, so nothing was public. |
| 3i | `v_value_legacy` holds the original spelling on every migrated variant, and `slug-map.json` holds every address change. Keep both for **one release**, then a follow-up can drop `v_value_legacy`. |

A migration that fails verification exits non-zero and prints which check failed. None of them
writes partially on purpose: the two riskiest pin the array they read in the update filter, so a
document edited in the admin mid-run is skipped and reported rather than overwritten.
